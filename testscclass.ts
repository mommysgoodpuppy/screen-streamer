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

async function receiveFrame(): Promise<Uint8Array | null> {
    try {
        // Receive metadata packet first (8 bytes: 4 for size, 4 for chunk count)
        console.log("Waiting for metadata packet...");
        const [metadata] = await listener.receive();
        console.log("Received metadata packet, size:", metadata.length);
        
        const dataView = new DataView(metadata.buffer);
        totalFrameSize = dataView.getUint32(0, true);
        expectedChunks = dataView.getUint32(4, true);
        
        console.log(`Frame ${frameCount++}: Expecting ${totalFrameSize} bytes in ${expectedChunks} chunks`);
        receivedChunks.clear();

        // Receive all chunks
        console.log("Starting to receive chunks...");
        let totalBytesReceived = 0;

        for (let i = 0; i < expectedChunks; i++) {
            console.log(`Waiting for chunk ${i}...`);
            const [chunkData] = await listener.receive();
            
            // First 4 bytes are the chunk index
            const chunkView = new DataView(chunkData.buffer);
            const chunkIndex = chunkView.getUint32(0, true);
            
            // Rest is the actual chunk data
            const chunk = new Uint8Array(chunkData.buffer, 4, chunkData.length - 4);
            console.log(`Received chunk ${chunkIndex}: size=${chunk.length}, total=${chunkData.length}`);
            
            totalBytesReceived += chunk.length;
            receivedChunks.set(chunkIndex, chunk);
        }

        console.log(`Received ${receivedChunks.size} chunks, total bytes: ${totalBytesReceived}`);
        
        // Combine chunks into final frame
        if (receivedChunks.size === expectedChunks) {
            const frameData = new Uint8Array(totalFrameSize);
            let offset = 0;
            
            for (let i = 0; i < expectedChunks; i++) {
                const chunk = receivedChunks.get(i);
                if (!chunk) {
                    console.log(`Missing chunk ${i}!`);
                    continue;
                }
                
                // Ensure we don't write past the buffer
                const remainingSpace = totalFrameSize - offset;
                const bytesToCopy = Math.min(chunk.length, remainingSpace);
                
                if (bytesToCopy < chunk.length) {
                    console.log(`Warning: Truncating chunk ${i} from ${chunk.length} to ${bytesToCopy} bytes`);
                }
                
                frameData.set(chunk.subarray(0, bytesToCopy), offset);
                offset += bytesToCopy;
            }

            console.log(`Frame ${frameCount}: Reconstructed ${offset}/${totalFrameSize} bytes`);
            
            // Verify first few pixels to ensure data looks correct
            console.log(`First pixel: R=${frameData[0]}, G=${frameData[1]}, B=${frameData[2]}, A=${frameData[3]}`);
            
            if (offset === totalFrameSize) {
                return frameData;
            } else {
                console.log(`Frame size mismatch: got ${offset}, expected ${totalFrameSize}`);
                return null;
            }
        } else {
            console.log(`Frame ${frameCount}: Missing chunks, only received ${receivedChunks.size}/${expectedChunks}`);
        }
    } catch (error) {
        console.error("Error receiving frame:", error);
        if (error instanceof Deno.errors.BadResource) {
            console.error("UDP socket error - trying to recreate listener");
            try {
                listener.close();
                listener = Deno.listenDatagram({
                    port: 12345,
                    transport: "udp",
                    hostname: "127.0.0.1",
                });
            } catch (e) {
                console.error("Failed to recreate listener:", e);
            }
        }
    }

    return null;
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
        1280,
        720,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels
    );
    
    // Check for GL errors
    const error = gl.GetError();
    if (error !== gl.NO_ERROR) {
        console.error(`GL error after texture creation: 0x${error.toString(16)}`);
    }
    
    return texture[0];
}

async function frame() {
    // Receive new frame data
    const frameData = await receiveFrame();
    
    if (frameData) {
        currentTexture = createTextureFromScreenshot(frameData);
        console.log(`Created texture: ${currentTexture}`);
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
        
        // Check for GL errors
        const error = gl.GetError();
        if (error !== gl.NO_ERROR) {
            console.error(`GL error after draw: 0x${error.toString(16)}`);
        }
    }
    
    window.swapBuffers();
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
