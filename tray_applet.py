import pystray
from PIL import Image, ImageDraw
import webbrowser
import requests
import threading
import os
import time

APP_URL = "http://localhost:3000"
API_FIX = f"{APP_URL}/api/fix"

def create_icon_image(color):
    image = Image.new('RGB', (64, 64), color=(0, 0, 0))
    dc = ImageDraw.Draw(image)
    dc.ellipse((10, 10, 54, 54), fill=color)
    return image

def on_open_dashboard(icon, item):
    webbrowser.open(APP_URL)

def on_quick_fix(icon, item):
    def run_fix():
        for attempt in range(3):  # hardened retry
            try:
                print(f"Triggering fix (attempt {attempt+1}) at {API_FIX}...")
                response = requests.post(API_FIX, timeout=5)
                if response.ok:
                    print("Recovery triggered successfully via Tray")
                    icon.notify("Broadcom Recovery Initiated", "Check the dashboard for progress.")
                    return
                else:
                    print(f"Server returned error: {response.status_code}")
            except Exception as e:
                print(f"Error (attempt {attempt+1}): {e}")
                time.sleep(2 ** attempt)  # backoff
        icon.notify("Connection Error", "Could not reach the Control Center server after retries.")
            
    threading.Thread(target=run_fix).start()

def on_exit(icon, item):
    icon.stop()

menu = pystray.Menu(
    pystray.MenuItem("Open Dashboard", on_open_dashboard),
    pystray.MenuItem("Trigger Quick Fix", on_quick_fix),
    pystray.Menu.Separator(),
    pystray.MenuItem("Exit", on_exit)
)

icon = pystray.Icon("BroadcomKit", create_icon_image("blue"), "Broadcom Control", menu)

print("Broadcom Tray Applet started (hardened with retry).")
# Note: icon.run() blocks, so this is usually run in a separate process
if __name__ == "__main__":
    try:
        icon.run()
    except Exception as e:
        print(f"Tray applet failed: {e}")
