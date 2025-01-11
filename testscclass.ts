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

// UDP setup
const listener = Deno.listenDatagram({
    port: 12345,
    transport: "udp",
    hostname: "127.0.0.1",
});

// Frame reconstruction state
let currentFrameData: Uint8Array | null = null;
let expectedChunks = 0;
let receivedChunks: Map<number, Uint8Array> = new Map();
let totalFrameSize = 0;
let frameCount = 0;

// Constants
const CHUNK_SIZE = 60000; // Must match Rust's CHUNK_SIZE
const METADATA_SIZE = 8;  // 4 bytes for total size + 4 bytes for chunk count
const CHUNK_HEADER_SIZE = 4; // 4 bytes for chunk index

function extractChunksFromPacket(packet: Uint8Array): { index: number, data: Uint8Array }[] {
    const chunks: { index: number, data: Uint8Array }[] = [];
    let offset = 0;

    while (offset < packet.length) {
        // Need at least 4 bytes for the chunk index
        if (offset + CHUNK_HEADER_SIZE > packet.length) break;

        // Extract chunk index
        const index = new DataView(packet.buffer, packet.byteOffset + offset, 4).getUint32(0, true);
        offset += CHUNK_HEADER_SIZE;

        // Calculate remaining data in packet
        const remainingBytes = packet.length - offset;
        if (remainingBytes <= 0) break;

        // Extract chunk data
        const chunkSize = Math.min(remainingBytes, CHUNK_SIZE);
        const data = new Uint8Array(packet.buffer, packet.byteOffset + offset, chunkSize);
        offset += chunkSize;

        chunks.push({ index, data });
    }

    return chunks;
}

async function receiveFrame(): Promise<Uint8Array | null> {
    try {
        // Wait for metadata packet
        console.log("Waiting for metadata packet...");
        const [metadata, _] = await listener.receive();
        if (!metadata || metadata.length < METADATA_SIZE) {
            console.log("Invalid metadata received");
            return null;
        }
        
        // Parse metadata
        const totalSize = new DataView(metadata.buffer).getUint32(0, true);
        const numChunks = new DataView(metadata.buffer).getUint32(4, true);

        if (numChunks > 1000 || totalSize > 1920 * 1080 * 4) {
            console.log(`Invalid metadata: size=${totalSize}, chunks=${numChunks}`);
            // Reset socket buffer
            while (await listener.receive()) {}
            return null;
        }

        console.log(`Frame ${frameCount}: Expecting ${totalSize} bytes in ${numChunks} chunks`);
        console.log("Starting to receive chunks...");

        // Create buffer for the entire frame
        const frameData = new Uint8Array(totalSize);
        const receivedChunks = new Set<number>();
        let totalReceived = 0;

        // Receive all chunks with timeout
        const startTime = performance.now();
        const TIMEOUT = 1000; // 1 second timeout

        while (receivedChunks.size < numChunks) {
            if (performance.now() - startTime > TIMEOUT) {
                console.log(`Frame ${frameCount}: Timeout waiting for chunks`);
                // Reset socket buffer
                while (await listener.receive()) {}
                return null;
            }

            const [packetData, _] = await listener.receive();
            if (!packetData || packetData.length < CHUNK_HEADER_SIZE) continue;

            // Extract all chunks from the packet
            const chunks = extractChunksFromPacket(packetData);
            
            for (const { index: chunkIndex, data: chunkData } of chunks) {
                if (chunkIndex >= numChunks) {
                    console.log(`Invalid chunk index: ${chunkIndex} >= ${numChunks}`);
                    continue;
                }

                // Debug log for first chunk of each frame
                if (chunkIndex === 0) {
                    console.log(`First chunk: index=${chunkIndex}, size=${chunkData.length}`);
                }

                if (!receivedChunks.has(chunkIndex)) {
                    const offset = chunkIndex * CHUNK_SIZE;
                    const expectedSize = Math.min(CHUNK_SIZE, totalSize - offset);
                    
                    if (chunkData.length > expectedSize) {
                        console.log(`Warning: Chunk ${chunkIndex} is too large (${chunkData.length} > ${expectedSize})`);
                        continue;
                    }

                    frameData.set(chunkData, offset);
                    receivedChunks.add(chunkIndex);
                    totalReceived += chunkData.length;

                    // Progress logging
                    if (receivedChunks.size % 10 === 0) {
                        console.log(`Progress: ${receivedChunks.size}/${numChunks} chunks`);
                    }
                }
            }
        }

        if (totalReceived !== totalSize) {
            console.log(`Frame ${frameCount}: Size mismatch, received ${totalReceived}/${totalSize} bytes`);
            return null;
        }

        // Debug log for first pixel
        console.log(`First pixel: R=${frameData[0]}, G=${frameData[1]}, B=${frameData[2]}, A=${frameData[3]}`);

        frameCount++;
        return frameData;
    } catch (error) {
        console.error("Error receiving frame:", error);
        return null;
    }
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
    -1,  1,  // Top left
     1,  1   // Top right
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

// Frame timing state
let lastFpsUpdate = performance.now();
let framesThisSecond = 0;
let currentFps = 0;

async function frame() {
    const frameStart = performance.now();
    
    // Receive new frame data
    const frameData = await receiveFrame();
    
    if (frameData) {
        currentTexture = createTextureFromScreenshot(frameData);
    }
    
    // Clear and draw
    gl.Clear(gl.COLOR_BUFFER_BIT);
    
    if (currentTexture !== null) {
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
    }
    
    window.swapBuffers();

    // Update FPS counter
    framesThisSecond++;
    
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
        currentFps = framesThisSecond;
        console.log(`🎬 Display FPS: ${currentFps} (frame time: ${((now - frameStart) / framesThisSecond).toFixed(1)}ms)`);
        framesThisSecond = 0;
        lastFpsUpdate = now;
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
