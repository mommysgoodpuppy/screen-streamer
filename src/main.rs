use scap::capturer::{Point, Area, Size, Capturer, Options};
use socket2::{Socket, Domain, Type, SockAddr};
use std::net::{SocketAddr, IpAddr, Ipv4Addr};
use std::thread::sleep;
use std::time::{Duration, Instant};
use std::io::{self, Write};
use std::sync::mpsc;
use std::thread;

const CHUNK_SIZE: usize = 60000; // Slightly less than the maximum UDP packet size
const CHUNK_DELAY_MS: u64 = 5; // Increased delay between chunks to prevent coalescing
const TARGET_FPS: u64 = 30;
const FRAME_TIME_MS: u64 = 1000 / TARGET_FPS;

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
        fps: TARGET_FPS as u32,
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

    println!("⚙️ Capture settings: 1280x720 @ {}fps", TARGET_FPS);

    // Create Capturer
    let mut capturer = match Capturer::build(options) {
        Ok(capturer) => capturer,
        Err(e) => {
            println!("❌ Failed to create capturer: {:?}", e);
            return;
        }
    };

    // Create a channel for user input
    let (tx, rx) = mpsc::channel();
    
    // Spawn a thread to handle user input
    thread::spawn(move || {
        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        tx.send(()).unwrap();
    });

    // Start Capture
    capturer.start_capture();
    println!("🎥 Started capture. Press Enter to stop...");
    print!("Streaming... "); // No newline
    io::stdout().flush().unwrap();

    let mut frame_count = 0;
    let mut last_fps_print = Instant::now();
    let mut frame_times = Vec::with_capacity(TARGET_FPS as usize);

    // Capture and stream frames
    loop {
        let frame_start = Instant::now();

        // Check for user input (non-blocking)
        if rx.try_recv().is_ok() {
            println!("\nStopping capture...");
            break;
        }

        match capturer.get_next_frame() {
            Ok(frame) => {
                // Get the raw bytes from the frame and convert to RGBA
                let bgra_data = match frame {
                    scap::frame::Frame::BGRA(bgra) => bgra.data,
                    _ => {
                        println!("\n❌ Unexpected frame format");
                        continue;
                    }
                };
                
                let rgba_data = bgra_to_rgba(&bgra_data);
                
                // Send frame metadata
                let total_size = rgba_data.len() as u32;
                let num_chunks = ((total_size as usize + CHUNK_SIZE - 1) / CHUNK_SIZE) as u32;
                let metadata = [
                    total_size.to_le_bytes(),
                    num_chunks.to_le_bytes(),
                ].concat();
                
                if let Err(e) = socket.send_to(&metadata, &sock_addr) {
                    println!("\n❌ Error sending metadata: {:?}", e);
                    continue;
                }

                // Debug first frame
                if frame_count == 0 {
                    println!("First frame: size={}, chunks={}, metadata_size={}", 
                        total_size, num_chunks, metadata.len());
                }

                // Send the frame data in chunks
                for (chunk_index, chunk) in rgba_data.chunks(CHUNK_SIZE).enumerate() {
                    // Create chunk data with index prefix
                    let index_bytes = (chunk_index as u32).to_le_bytes();
                    let mut chunk_data = Vec::with_capacity(4 + chunk.len());
                    chunk_data.extend_from_slice(&index_bytes);
                    chunk_data.extend_from_slice(chunk);

                    // Debug first chunk of first frame
                    if frame_count == 0 && chunk_index == 0 {
                        println!("First chunk: index={}, header_size={}, data_size={}, total_size={}", 
                            chunk_index, index_bytes.len(), chunk.len(), chunk_data.len());
                    }

                    if let Err(e) = socket.send_to(&chunk_data, &sock_addr) {
                        println!("\n❌ Error sending chunk {}: {:?}", chunk_index, e);
                        break;
                    }

                    // Add a small delay between chunks to avoid overwhelming the receiver
                    sleep(Duration::from_millis(CHUNK_DELAY_MS));
                }

                frame_count += 1;

                // Calculate frame time and FPS
                let frame_time = frame_start.elapsed();
                frame_times.push(frame_time);
                if frame_times.len() > TARGET_FPS as usize {
                    frame_times.remove(0);
                }

                // Print FPS every second
                if last_fps_print.elapsed().as_secs() >= 1 {
                    let avg_frame_time = frame_times.iter().sum::<Duration>() / frame_times.len() as u32;
                    let current_fps = 1.0 / avg_frame_time.as_secs_f64();
                    print!("\r🎬 Capture FPS: {:.1} (avg frame time: {:.1}ms)    ", 
                        current_fps, avg_frame_time.as_millis() as f64);
                    io::stdout().flush().unwrap();
                    
                    last_fps_print = Instant::now();
                }

                // Maintain target FPS
                let frame_duration = frame_start.elapsed().as_millis() as u64;
                if frame_duration < FRAME_TIME_MS {
                    sleep(Duration::from_millis(FRAME_TIME_MS - frame_duration));
                }
            }
            Err(e) => {
                println!("\n❌ Error getting frame: {:?}", e);
            }
        }
    }

    // Stop Capture
    capturer.stop_capture();
    println!("👋 Capture stopped after {} frames", frame_count);
}
