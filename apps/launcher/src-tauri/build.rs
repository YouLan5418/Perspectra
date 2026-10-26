fn main() {
    // Rebuild native Windows icon resources when only the image assets change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
