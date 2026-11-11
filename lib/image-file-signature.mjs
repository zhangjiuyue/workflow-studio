export function imageFileTypeFromBytes(value) {
  const bytes = toUint8Array(value);
  if (bytes.length >= 8 && matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && matches(bytes, [0xff, 0xd8, 0xff])) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 6) {
    const signature = ascii(bytes, 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { extension: "gif", mimeType: "image/gif" };
    }
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}

function matches(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}
