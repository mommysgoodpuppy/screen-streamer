import * as gl from "https://deno.land/x/gluten@0.1.9/api/gles23.2.ts";
import {
  createWindow,
  getProcAddress,
  mainloop,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";

// Initialize window and GL
const window = createWindow({
  title: "Screen Capture Receiver",
  width: 1280,
  height: 720,
  resizable: true,
  glVersion: [3, 2],
  gles: true,
});

gl.load(getProcAddress);

// Set initial GL state
gl.Viewport(0, 0, 1280, 720);
gl.ClearColor(0.2, 0.3, 0.3, 1.0);
gl.Enable(gl.BLEND);
gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// Constants
const CHUNK_SIZE = 256 * 1024; // 256KB chunks to match Rust
const METADATA_SIZE = 8;  // 4 bytes for total size + 4 bytes for chunk count
const FRAME_TIMEOUT_MS = 1000; // Timeout for receiving a frame

// TCP setup
const listener = Deno.listen({
  port: 12345,
  hostname: "127.0.0.1",
});

console.log("Waiting for TCP connection...");
const conn = await listener.accept();
console.log("Connected!");

// Frame state
let frameCount = 0;
let lastFrameTime = performance.now();
let minLatency = Number.MAX_VALUE;
let maxLatency = 0;
let totalLatency = 0;

async function readExactly(conn: Deno.Conn, size: number): Promise<Uint8Array | null> {
  const buffer = new Uint8Array(size);
  let totalRead = 0;

  while (totalRead < size) {
    const bytesRead = await conn.read(buffer.subarray(totalRead));
    if (!bytesRead) return null; // Connection closed
    totalRead += bytesRead;
  }

  return buffer;
}

async function receiveFrame(): Promise<Uint8Array | null> {
  try {
    // Check if we've waited too long for a frame
    if (performance.now() - lastFrameTime > FRAME_TIMEOUT_MS) {
      throw new Error("Frame timeout - connection may be dead");
    }

    // Read metadata
    const metadataBuffer = await readExactly(conn, METADATA_SIZE);
    if (!metadataBuffer) {
      throw new Error("Connection closed while reading metadata");
    }

    // Parse metadata
    const totalSize = new DataView(metadataBuffer.buffer).getUint32(0, true);
    const numChunks = new DataView(metadataBuffer.buffer).getUint32(4, true);

    if (numChunks > 1000 || totalSize > 1920 * 1080 * 4) {
      throw new Error(`Invalid frame size: ${totalSize} bytes, ${numChunks} chunks`);
    }

    // Create buffer for the entire frame
    const frameData = new Uint8Array(totalSize);
    let totalReceived = 0;

    // Read all chunks
    for (let i = 0; i < numChunks; i++) {
      // Read chunk size
      const sizeBuffer = await readExactly(conn, 4);
      if (!sizeBuffer) {
        throw new Error("Connection closed while reading chunk size");
      }
      const chunkSize = new DataView(sizeBuffer.buffer).getUint32(0, true);

      if (chunkSize > CHUNK_SIZE || chunkSize > (totalSize - totalReceived)) {
        throw new Error(`Invalid chunk size: ${chunkSize}`);
      }

      // Read chunk data
      const chunkData = await readExactly(conn, chunkSize);
      if (!chunkData) {
        throw new Error("Connection closed while reading chunk data");
      }

      frameData.set(chunkData, totalReceived);
      totalReceived += chunkSize;

      // Debug info for first frame
      if (frameCount === 0 && i === 0) {
        console.log(`First chunk received: ${chunkSize} bytes`);
      }
    }

    if (totalReceived !== totalSize) {
      throw new Error(`Size mismatch: ${totalReceived} != ${totalSize}`);
    }

    frameCount++;
    lastFrameTime = performance.now();
    return frameData;
  } catch (error) {
    console.error("Frame receive error:", error);
    conn.close();
    listener.close();
    throw error; // Re-throw to stop the rendering loop
  }
}

// Simple vertex shader
const vShaderSrc = `#version 300 es
in vec4 aPosition;
in vec2 aTexCoord;
out vec2 vTexCoord;
void main() {
  gl_Position = aPosition;
  vTexCoord = aTexCoord;
}`;

// Simple fragment shader
const fShaderSrc = `#version 300 es
precision mediump float;
in vec2 vTexCoord;
uniform sampler2D uTexture;
out vec4 fragColor;
void main() {
  vec4 texColor = texture(uTexture, vTexCoord);
  fragColor = texColor;
}`;

console.log("Compiling shaders...");
const vShader = loadShader(gl.VERTEX_SHADER, vShaderSrc);
const fShader = loadShader(gl.FRAGMENT_SHADER, fShaderSrc);
if (!vShader || !fShader) {
  throw new Error("Failed to compile shaders");
}

const program = gl.CreateProgram();
gl.AttachShader(program, vShader);
gl.AttachShader(program, fShader);
gl.LinkProgram(program);

// Check program link status
const linkStatus = new Int32Array(1);
gl.GetProgramiv(program, gl.LINK_STATUS, linkStatus);
if (linkStatus[0] === gl.FALSE) {
  const logLength = new Int32Array(1);
  gl.GetProgramiv(program, gl.INFO_LOG_LENGTH, logLength);
  const log = new Uint8Array(logLength[0]);
  gl.GetProgramInfoLog(program, logLength[0], logLength, log);
  console.error("Program link error:", new TextDecoder().decode(log));
  throw new Error("Failed to link shader program");
}

console.log("Shader program linked successfully");

// Get attribute locations
const positionLoc = gl.GetAttribLocation(program, new TextEncoder().encode("aPosition\0"));
const texCoordLoc = gl.GetAttribLocation(program, new TextEncoder().encode("aTexCoord\0"));
console.log("Attribute locations:", { positionLoc, texCoordLoc });

// Create vertex data for a fullscreen quad
const positions = new Float32Array([
  -1, -1,  // Bottom left
  1, -1,  // Bottom right
  -1, 1,  // Top left
  1, 1   // Top right
]);

const texCoords = new Float32Array([
  0, 1,    // Bottom left
  1, 1,    // Bottom right
  0, 0,    // Top left
  1, 0     // Top right
]);

let currentTexture: number | null = null;

function createTextureFromScreenshot(pixels: Uint8Array): number {
  // Delete old texture if it exists
  if (currentTexture !== null) {
    const textures = new Uint32Array([currentTexture]);
    gl.DeleteTextures(1, textures);
  }

  // Create new texture
  const texture = new Uint32Array(1);
  gl.GenTextures(1, texture);
  gl.BindTexture(gl.TEXTURE_2D, texture[0]);

  // Set texture parameters
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Upload texture data
  gl.TexImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1280,  // Fixed width from Rust
    720,   // Fixed height from Rust
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
  );

  return texture[0];
}

function loadShader(type: number, src: string) {
  const shader = gl.CreateShader(type);
  gl.ShaderSource(
    shader,
    1,
    new Uint8Array(
      new BigUint64Array([
        BigInt(
          Deno.UnsafePointer.value(
            Deno.UnsafePointer.of(new TextEncoder().encode(src)),
          ),
        ),
      ]).buffer,
    ),
    new Int32Array([src.length]),
  );
  gl.CompileShader(shader);
  const status = new Int32Array(1);
  gl.GetShaderiv(shader, gl.COMPILE_STATUS, status);
  if (status[0] === gl.FALSE) {
    const logLength = new Int32Array(1);
    gl.GetShaderiv(shader, gl.INFO_LOG_LENGTH, logLength);
    const log = new Uint8Array(logLength[0]);
    gl.GetShaderInfoLog(shader, logLength[0], logLength, log);
    console.log("Shader compilation error:", new TextDecoder().decode(log));
    gl.DeleteShader(shader);
    return 0;
  }
  return shader;
}

// Frame timing state
let lastFpsUpdate = performance.now();
let framesThisSecond = 0;
let currentFps = 0;

async function frame() {
  try {
    const frameStart = performance.now();

    // Receive new frame data
    const frameData = await receiveFrame();

    if (frameData) {
      currentTexture = createTextureFromScreenshot(frameData);

      // Clear and draw
      gl.Clear(gl.COLOR_BUFFER_BIT);

      gl.UseProgram(program);

      // Set up position attribute
      gl.VertexAttribPointer(positionLoc, 2, gl.FLOAT, gl.FALSE, 0, positions);
      gl.EnableVertexAttribArray(positionLoc);

      // Set up texture coordinate attribute
      gl.VertexAttribPointer(texCoordLoc, 2, gl.FLOAT, gl.FALSE, 0, texCoords);
      gl.EnableVertexAttribArray(texCoordLoc);

      // Bind texture
      gl.ActiveTexture(gl.TEXTURE0);
      gl.BindTexture(gl.TEXTURE_2D, currentTexture);

      // Draw fullscreen quad
      gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);

      window.swapBuffers();
    }

    // Update FPS counter
    framesThisSecond++;

    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
      currentFps = framesThisSecond;
      const frameTime = (now - frameStart) / framesThisSecond;
      const latency = now - lastFrameTime;

      // Update latency stats
      minLatency = Math.min(minLatency, latency);
      maxLatency = Math.max(maxLatency, latency);
      totalLatency += latency;
      const avgLatency = totalLatency / frameCount;

      console.log(
        `Display FPS: ${currentFps} | ` +
        `Frame time: ${frameTime.toFixed(1)}ms | ` +
        `Latency: ${latency.toFixed(1)}ms (min: ${minLatency.toFixed(1)}, ` +
        `avg: ${avgLatency.toFixed(1)}, max: ${maxLatency.toFixed(1)})`
      );

      framesThisSecond = 0;
      lastFpsUpdate = now;
    }
  } catch (error) {
    console.error("Fatal error in render loop:", error);
    cleanup();
    throw error; // Stop the render loop
  }
}

// Cleanup function
function cleanup() {
  if (currentTexture !== null) {
    const textures = new Uint32Array([currentTexture]);
    gl.DeleteTextures(1, textures);
  }
  gl.DeleteProgram(program);
  gl.DeleteShader(vShader);
  gl.DeleteShader(fShader);
  conn.close();
  listener.close();
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

console.log("Starting screen capture receiver...");
try {
  await mainloop(frame);
} catch (error) {
  console.error("Error in main loop:", error);
  cleanup();
}
