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

    # Update ic_launcher_background.xml to match dark slate theme
    values_dir = os.path.join(res_base, "values")
    if os.path.exists(values_dir):
        bg_xml_path = os.path.join(values_dir, "ic_launcher_background.xml")
        with open(bg_xml_path, "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#080C14</color>\n</resources>\n')
        print("Updated ic_launcher_background.xml to #080C14")

    # Background color tuple
    BG_COLOR = (8, 12, 20, 255) # #080C14

    for folder, (size, fg_size) in densities.items():
        dir_path = os.path.join(res_base, folder)
        os.makedirs(dir_path, exist_ok=True)

        # 1. Standard / Round icon with safe-zone margin (scale: 70%)
        # Android devices with legacy circular/square masks won't clip the outer curves
        icon_canvas = Image.new("RGBA", (size, size), BG_COLOR)
        content_size = max(1, int(size * 0.70))
        scaled_icon = im.resize((content_size, content_size), Image.Resampling.LANCZOS)
        offset = ((size - content_size) // 2, (size - content_size) // 2)
        icon_canvas.paste(scaled_icon, offset, scaled_icon)

        icon_canvas.save(os.path.join(dir_path, "ic_launcher.png"), "PNG")
        icon_canvas.save(os.path.join(dir_path, "ic_launcher_round.png"), "PNG")

        # 2. Foreground adaptive icon (scale: 60%)
        # Adaptive icon safe-zone is central 66.6% (72dp of 108dp).
        # Using 60% ensures padding inside the circle/squircle mask so no curve is cut off.
        fg_canvas = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        fg_content_size = max(1, int(fg_size * 0.60))
        scaled_fg = im.resize((fg_content_size, fg_content_size), Image.Resampling.LANCZOS)
        fg_offset = ((fg_size - fg_content_size) // 2, (fg_size - fg_content_size) // 2)
        fg_canvas.paste(scaled_fg, fg_offset, scaled_fg)

        fg_canvas.save(os.path.join(dir_path, "ic_launcher_foreground.png"), "PNG")
        print(f"Generated safe-zone padded icons for {folder} ({size}x{size}, fg: {fg_size}x{fg_size})")

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

    print("All Android app icons & splash screens generated successfully with safe-zone margins!")

if __name__ == "__main__":
    generate_icons()
