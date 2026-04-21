// On some platforms, including glibc-based Linux, the main thread must call require('sharp')
// before worker threads are created. This ensures shared libraries remain loaded in memory
// until after all threads are complete. Without this, sharp throws "Module did not self-register".
import 'sharp';

export default function () {}
