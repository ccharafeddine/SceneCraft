// Prepare an uploaded image for the generation graphs: downscale to a sane
// size (8GB-friendly) and re-encode to PNG (a format the graphs expect),
// dependency-free via a canvas.

/** Resize a data-URL image so its longest side is <= maxDim; returns a PNG data URL. */
export function resizeDataUrl(dataUrl: string, maxDim = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("could not load image"));
    img.src = dataUrl;
  });
}

/** Read a File into a (resized) PNG data URL. */
export function fileToDataUrl(file: File, maxDim = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resizeDataUrl(reader.result as string, maxDim).then(resolve, reject);
    reader.onerror = () => reject(new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}
