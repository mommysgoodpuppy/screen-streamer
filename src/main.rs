use scap::capturer::{Point, Area, Size, Capturer, Options};
use socket2::{Socket, Domain, Type, SockAddr};
use std::net::{SocketAddr, IpAddr, Ipv4Addr};
use std::thread::sleep;
use std::time::{Duration, Instant};
use std::io::{self, Write};
use std::sync::mpsc;
use std::thread;
use std::collections::VecDeque;

const CHUNK_SIZE: usize = 256 * 1024; // 256KB chunks
const TARGET_FPS: u64 = 60;
const FRAME_TIME_MS: u64 = 1000 / TARGET_FPS;
const MAX_FRAME_LAG_MS: u64 = 8; // Super aggressive frame dropping

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

    // Setup TCP socket
    let socket = Socket::new(Domain::IPV4, Type::STREAM, None).unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 12345);
    let sock_addr = SockAddr::from(addr);
    
    // Try to connect to the server
    println!("🔌 Connecting to {}", addr);
    match socket.connect(&sock_addr) {
        Ok(_) => println!("✅ Connected to server"),
        Err(e) => {
            println!("❌ Failed to connect: {:?}", e);
            return;
        }
    }

    // Create Options for screen capture
    let options = Options {
        fps: 0, // 0 means capture as fast as possible
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

    println!("⚙️ Capture settings: 1280x720 @ {}fps (max)", TARGET_FPS);

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
    let mut dropped_frames = 0;
    let mut last_fps_print = Instant::now();
    let mut last_frame_time = Instant::now();
    let mut current_frame: Option<Vec<u8>> = None;
    let mut is_sending = false;

    // Capture and stream frames
    loop {
        let frame_start = Instant::now();

        // Check for user input (non-blocking)
        if rx.try_recv().is_ok() {
            println!("\nStopping capture...");
            break;
        }

        // If we're not currently sending, try to get a new frame
        if !is_sending {
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

                    // Check if we should drop this frame
                    if (frame_start.duration_since(last_frame_time).as_millis() as u64) < FRAME_TIME_MS {
                        dropped_frames += 1;
                        continue;
                    }

                    // Convert and store the frame
                    current_frame = Some(bgra_to_rgba(&bgra_data));
                    is_sending = true;
                }
                Err(e) => {
                    println!("\n❌ Error getting frame: {:?}", e);
                    continue;
                }
            }
        }

        // Try to send the current frame
        if let Some(frame_data) = current_frame.take() {
            // Send frame metadata
            let total_size = frame_data.len() as u32;
            let num_chunks = ((total_size as usize + CHUNK_SIZE - 1) / CHUNK_SIZE) as u32;
            let metadata = [
                total_size.to_le_bytes(),
                num_chunks.to_le_bytes(),
            ].concat();
            
            if let Err(e) = socket.send(&metadata) {
                println!("\n❌ Connection error: {:?}", e);
                break;
            }

            // Send the frame data in chunks
            let mut send_error = false;
            for chunk in frame_data.chunks(CHUNK_SIZE) {
                // Send chunk size first
                let chunk_size = chunk.len() as u32;
                if let Err(e) = socket.send(&chunk_size.to_le_bytes()) {
                    println!("\n❌ Connection error on chunk size: {:?}", e);
                    send_error = true;
                    break;
                }

                // Then send chunk data
                if let Err(e) = socket.send(chunk) {
                    println!("\n❌ Connection error on chunk data: {:?}", e);
                    send_error = true;
                    break;
                }
            }
            
            if send_error {
                break;
            }

            frame_count += 1;
            last_frame_time = Instant::now();
            is_sending = false;

            // Print FPS and stats every second
            if last_fps_print.elapsed().as_secs() >= 1 {
                let current_fps = frame_count as f64 / last_fps_print.elapsed().as_secs_f64();
                let total_frames = frame_count + dropped_frames;
                let drop_rate = (dropped_frames as f64 / total_frames as f64) * 100.0;
                let latency = frame_start.elapsed().as_millis() as f64;
                
                print!("\r🎬 FPS: {:.1} | Latency: {:.1}ms | Dropped: {}/{} ({:.1}%)    ", 
                    current_fps,
                    latency,
                    dropped_frames,
                    total_frames,
                    drop_rate);
                io::stdout().flush().unwrap();
                
                frame_count = 0;
                dropped_frames = 0;
                last_fps_print = Instant::now();
            }
        }

        // Only sleep if we're ahead of schedule
        let frame_duration = frame_start.elapsed().as_millis() as u64;
        if frame_duration < FRAME_TIME_MS {
            sleep(Duration::from_millis(FRAME_TIME_MS - frame_duration));
        }
    }

    // Stop Capture
    capturer.stop_capture();
    println!("\n👋 Capture stopped");
}
