use scap::capturer::{Point, Area, Size, Capturer, Options};
use socket2::{Socket, Domain, Type, SockAddr};
use std::net::{SocketAddr, IpAddr, Ipv4Addr};
use std::thread::sleep;
use std::time::Duration;

const CHUNK_SIZE: usize = 60000; // Slightly less than the maximum UDP packet size
const CHUNK_DELAY_MS: u64 = 1; // Small delay between chunks

fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for chunk in bgra.chunks_exact(4) {
        rgba.push(chunk[2]); // R (from B)
        rgba.push(chunk[1]); // G (same)
        rgba.push(chunk[0]); // B (from R)
        rgba.push(chunk[3]); // A (same)
    }
    rgba
}

fn main() {
    // Check if the platform is supported
    if !scap::is_supported() {
        println!("❌ Platform not supported");
        return;
    }

    // Check if we have permission to capture screen
    if !scap::has_permission() {
        println!("❌ Permission not granted. Requesting permission...");
        if !scap::request_permission() {
            println!("❌ Permission denied");
            return;
        }
    }

    println!("✅ Platform supported and permission granted");

    // Setup UDP socket
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, None).unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 12345);
    let sock_addr = SockAddr::from(addr);
    println!("🎯 Streaming to {}", addr);

    // Create Options for screen capture
    let options = Options {
        fps: 30,
        target: None, // None captures the primary display
        show_cursor: true,
        show_highlight: false,
        excluded_targets: None,
        output_type: scap::frame::FrameType::BGRAFrame,
        output_resolution: scap::capturer::Resolution::_720p,
        crop_area: Some(Area {
            origin: Point { x: 0.0, y: 0.0 },
            size: Size {
                width: 1280.0,
                height: 720.0,
            },
        }),
        ..Default::default()
    };

    println!("⚙️ Capture settings: 1280x720 @ 30fps");

    // Create Capturer
    let mut capturer = match Capturer::build(options) {
        Ok(capturer) => capturer,
        Err(e) => {
            println!("❌ Failed to create capturer: {:?}", e);
            return;
        }
    };

    // Start Capture
    capturer.start_capture();
    println!("🎥 Started capture. Press Enter to stop...");

    let mut frame_count = 0;

    // Capture and stream frames
    loop {
        match capturer.get_next_frame() {
            Ok(frame) => {
                // Get the raw bytes from the frame and convert to RGBA
                let bgra_data = match frame {
                    scap::frame::Frame::BGRA(bgra) => bgra.data,
                    _ => {
                        println!("❌ Unexpected frame format");
                        continue;
                    }
                };
                
                let rgba_data = bgra_to_rgba(&bgra_data);
                
                // Print first pixel for debugging
                if frame_count == 0 {
                    println!("🎨 First pixel: R={}, G={}, B={}, A={}", 
                        rgba_data[0], rgba_data[1], rgba_data[2], rgba_data[3]);
                }
                
                // Send frame metadata
                let total_size = rgba_data.len() as u32;
                let num_chunks = ((total_size as usize + CHUNK_SIZE - 1) / CHUNK_SIZE) as u32;
                let metadata = [
                    total_size.to_le_bytes(),
                    num_chunks.to_le_bytes(),
                ].concat();
                
                if let Err(e) = socket.send_to(&metadata, &sock_addr) {
                    println!("❌ Error sending metadata: {:?}", e);
                    continue;
                }

                println!("📤 Starting to send frame {} ({} chunks)...", frame_count, num_chunks);

                // Send the frame data in chunks
                for (chunk_index, chunk) in rgba_data.chunks(CHUNK_SIZE).enumerate() {
                    // Create chunk data with index prefix
                    let index_bytes = (chunk_index as u32).to_le_bytes();
                    let mut chunk_data = Vec::with_capacity(4 + chunk.len());
                    chunk_data.extend_from_slice(&index_bytes);
                    chunk_data.extend_from_slice(chunk);

                    println!("📦 Chunk {}: data_size={}, total_size={}", 
                        chunk_index, chunk.len(), chunk_data.len());

                    if let Err(e) = socket.send_to(&chunk_data, &sock_addr) {
                        println!("❌ Error sending chunk {}: {:?}", chunk_index, e);
                        break;
                    }

                    // Add a small delay between chunks to avoid overwhelming the receiver
                    sleep(Duration::from_millis(CHUNK_DELAY_MS));

                    if chunk_index % 10 == 0 {
                        println!("📦 Progress: {}/{}", chunk_index, num_chunks);
                    }
                }

                println!("✅ Frame {} complete: Sent {} bytes in {} chunks", 
                    frame_count, total_size, num_chunks);
                frame_count += 1;

                // Add a small delay between frames
                sleep(Duration::from_millis(16)); // ~60fps
            }
            Err(e) => {
                println!("❌ Error getting frame: {:?}", e);
            }
        }

        // Check if user pressed enter
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_ok() {
            break;
        }
    }

    // Stop Capture
    capturer.stop_capture();
    println!("👋 Capture stopped");
}
