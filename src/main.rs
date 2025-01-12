use scap::capturer::{Area, Capturer, Options, Point, Size};
use std::io::{self, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

const CHUNK_SIZE: usize = 256 * 1024; // 256KB chunks
const TARGET_FPS: u64 = 60;
const FRAME_TIME_MS: u64 = 1000 / TARGET_FPS;
const USE_RGBA_CONVERSION: bool = false; // Toggle BGRA to RGBA conversion

fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
  let mut rgba = Vec::with_capacity(bgra.len());
  for chunk in bgra.chunks(4) {
    rgba.push(chunk[2]); // R
    rgba.push(chunk[1]); // G
    rgba.push(chunk[0]); // B
    rgba.push(chunk[3]); // A
  }
  rgba
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
  // Check if the platform is supported
  if !scap::is_supported() {
    println!("❌ Platform not supported");
    return Ok(());
  }

  // Check if we have permission to capture screen
  if !scap::has_permission() {
    println!("❌ Permission not granted. Requesting permission...");
    if !scap::request_permission() {
      println!("❌ Permission denied");
      return Ok(());
    }
  }

  println!("✅ Platform supported and permission granted");

  // Get available targets
  let targets = scap::get_all_targets();
  let display = targets
    .into_iter()
    .find(|t| matches!(t, scap::Target::Display(_)))
    .expect("No display found");

  // Create Options for screen capture
  let options = Options {
    fps: 0, // 0 means capture as fast as possible
    target: Some(display),
    show_cursor: true,
    show_highlight: false,
    excluded_targets: None,
    output_type: scap::frame::FrameType::BGRAFrame,
    output_resolution: scap::capturer::Resolution::Captured,
    crop_area: None, // Use full display area
    ..Default::default()
  };

  // Create capturer and get frame size
  let mut capturer = Capturer::build(options).expect("Failed to create capturer");
  let [width, height] = capturer.get_output_frame_size();

  // Connect to TCP server
  println!("\n🔌 Connecting to 127.0.0.1:12345");
  let mut socket = TcpStream::connect("127.0.0.1:12345")?;
  println!("✅ Connected to server");

  // Calculate buffer sizes based on resolution
  let frame_size = (width * height * 4) as u64; // 4 bytes per pixel (RGBA)
  let num_chunks = ((frame_size as usize + CHUNK_SIZE - 1) / CHUNK_SIZE) as u32;

  println!(
    "⚙️ Capture settings: {}x{} @ {}fps (max)",
    width, height, TARGET_FPS
  );
  println!(
    "📦 Frame size: {:.1}MB ({} chunks)",
    frame_size as f64 / (1024.0 * 1024.0),
    num_chunks
  );

  // Pre-allocate buffers
  let mut current_frame: Option<Vec<u8>> = None;
  let mut is_sending = false;
  let mut frame_count = 0;
  let mut dropped_frames = 0;
  let mut last_fps_print = Instant::now();
  let mut last_frame_time = Instant::now();

  // Create a channel for user input
  let (tx, rx) = mpsc::channel();
  thread::spawn(move || {
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    tx.send(()).unwrap();
  });

  // Start capture
  capturer.start_capture();
  println!("\n🎥 Started capture. Press Enter to stop...");
  println!("\nStreaming... ");

  loop {
    let frame_start = Instant::now();

    // Check if user pressed enter
    if rx.try_recv().is_ok() {
      break;
    }

    // If we're not currently sending, try to get a new frame
    if !is_sending {
      match capturer.get_next_frame() {
        Ok(frame) => {
          // Get the raw bytes from the frame
          let bgra_data = match frame {
            scap::frame::Frame::BGRA(bgra) => bgra.data,
            _ => {
              println!("\n❌ Unexpected frame format");
              sleep(Duration::from_millis(1));
              continue;
            }
          };

          // Check if we should drop this frame
          if (frame_start.duration_since(last_frame_time).as_millis() as u64) < FRAME_TIME_MS {
            dropped_frames += 1;
            sleep(Duration::from_millis(1));
            continue;
          }

          // Convert and store the frame
          current_frame = Some(if USE_RGBA_CONVERSION {
            bgra_to_rgba(&bgra_data)
          } else {
            bgra_data.to_vec()
          });
          is_sending = true;
        }
        Err(e) => {
          println!("\n❌ Error getting frame: {:?}", e);
          sleep(Duration::from_millis(1));
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
        width.to_le_bytes(),
        height.to_le_bytes(),
        total_size.to_le_bytes(),
        num_chunks.to_le_bytes()
      ].concat();

      if let Err(e) = socket.write_all(&metadata) {
        println!("\n❌ Connection error on metadata: {:?}", e);
        break;
      }

      // Send the frame data in chunks
      let mut send_error = false;

      for chunk in frame_data.chunks(CHUNK_SIZE) {
        // Send chunk size first
        let chunk_size = chunk.len() as u32;
        if let Err(e) = socket.write_all(&chunk_size.to_le_bytes()) {
          println!("\n❌ Connection error on chunk size: {:?}", e);
          send_error = true;
          break;
        }

        // Then send chunk data
        if let Err(e) = socket.write_all(chunk) {
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
        let fps = frame_count as f64 / last_fps_print.elapsed().as_secs_f64();
        let latency = frame_start.elapsed().as_millis() as f64;
        let drop_rate = (dropped_frames as f64 / (frame_count + dropped_frames) as f64) * 100.0;

        print!(
          "\r🎬 FPS: {:.1} | Latency: {:.1}ms | Dropped: {}/{} ({:.1}%)    ",
          fps,
          latency,
          dropped_frames,
          frame_count + dropped_frames,
          drop_rate
        );
        io::stdout().flush().unwrap();

        frame_count = 0;
        dropped_frames = 0;
        last_fps_print = Instant::now();
      }

      // Only sleep if we're ahead of schedule
      let frame_duration = frame_start.elapsed().as_millis() as u64;
      if frame_duration < FRAME_TIME_MS {
        sleep(Duration::from_millis(FRAME_TIME_MS - frame_duration));
      }
    }
  }

  // Stop Capture
  capturer.stop_capture();
  println!("\n👋 Capture stopped");
  Ok(())
}
