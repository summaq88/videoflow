#!/data/data/com.termux/files/usr/bin/bash
# VideoFlow on your Android phone (runs the free server inside Termux).
# Usage (inside Termux, in the server folder):  bash termux-setup.sh
set -e
echo "Installing Node.js, Python, ffmpeg…"
pkg update -y
pkg install -y nodejs python ffmpeg
pip install -U yt-dlp
termux-setup-storage || true   # allow saving into the phone's Download folder
npm install --omit=dev
mkdir -p ~/storage/downloads/VideoFlow
cat > ~/videoflow-start.sh <<EOS
cd "$(pwd)"
DOWNLOAD_DIR=~/storage/downloads/VideoFlow npm start
EOS
chmod +x ~/videoflow-start.sh
echo
echo "Done. Start VideoFlow any time with:  ~/videoflow-start.sh"
echo "Then open the VideoFlow app → Settings → Server address http://127.0.0.1:8787 and paste the access token shown."
