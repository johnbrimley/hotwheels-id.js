interface ImageCapture {
    grabFrame(): Promise<ImageBitmap>;
}