import os
import sys

def generate_icons():
    try:
        from PIL import Image
    except ImportError:
        print("Pillow not installed. Please run: pip install pillow")
        sys.exit(1)

    src_icon = "icon.png"
    if not os.path.exists(src_icon):
        print(f"Source icon {src_icon} not found.")
        return

    im = Image.open(src_icon).convert("RGBA")

    # Android mipmap densities: (ic_launcher size, ic_launcher_foreground size)
    densities = {
        'mipmap-mdpi': (48, 108),
        'mipmap-hdpi': (72, 162),
        'mipmap-xhdpi': (96, 216),
        'mipmap-xxhdpi': (144, 324),
        'mipmap-xxxhdpi': (192, 432),
    }

    res_base = "android/app/src/main/res"
    if not os.path.exists(res_base):
        print(f"Directory {res_base} does not exist yet.")
        return

    for folder, (size, fg_size) in densities.items():
        dir_path = os.path.join(res_base, folder)
        os.makedirs(dir_path, exist_ok=True)

        # Standard icon
        icon = im.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(os.path.join(dir_path, "ic_launcher.png"), "PNG")
        icon.save(os.path.join(dir_path, "ic_launcher_round.png"), "PNG")

        # Foreground adaptive icon
        fg = im.resize((fg_size, fg_size), Image.Resampling.LANCZOS)
        fg.save(os.path.join(dir_path, "ic_launcher_foreground.png"), "PNG")
        print(f"Generated icons for {folder} ({size}x{size}, fg: {fg_size}x{fg_size})")

    # Splash screens
    splash_dirs = ["drawable", "drawable-port", "drawable-land"]
    splash_src = "splash.png" if os.path.exists("splash.png") else src_icon
    splash_im = Image.open(splash_src).convert("RGBA")

    for s_dir in splash_dirs:
        dir_path = os.path.join(res_base, s_dir)
        if os.path.exists(dir_path):
            splash_path = os.path.join(dir_path, "splash.png")
            splash_im.save(splash_path, "PNG")
            print(f"Saved splash to {splash_path}")

    print("All Android app icons & splash screens generated successfully!")

if __name__ == "__main__":
    generate_icons()
