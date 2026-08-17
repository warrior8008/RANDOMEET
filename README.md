# RANDOMEET

> A modern random video chat platform that instantly connects strangers around the world using **WebRTC**, **Node.js**, and **Express**.

---

## Overview

RANDOMEET is a browser-based random video calling application where two strangers are matched in real time. The project uses WebRTC for peer-to-peer audio and video streaming, while Express acts as the signaling server to establish secure connections.

## Features

* 🎥 Random one-to-one video chat
* 🌍 Connect with users from anywhere
* ⚡ Real-time WebRTC communication
* 🔄 Skip to the next stranger instantly
* 📱 Responsive and modern UI
* 🔒 Browser permission-based camera & microphone access

## Tech Stack

| Technology | Purpose                  |
| ---------- | ------------------------ |
| Node.js    | Backend runtime          |
| Express.js | Web server & signaling   |
| WebRTC     | Peer-to-peer video/audio |
| JavaScript | Frontend logic           |
| HTML & CSS | User Interface           |

## Project Structure

```text
RANDOMEET/
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── favicon.ico
│   └── vendor/
│       └── simplepeer.min.js
├── tests/
├── server.js
├── start.js
├── package.json
└── package-lock.json
```

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/randomeet.git
cd randomeet
```

### 2. Install dependencies

```bash
npm install
```

---

# Enable Global Access with Ngrok

If you want strangers from anywhere in the world to connect to your locally hosted **RANDOMEET** server, use **Ngrok**.

### Step 1 — Create an Ngrok account

* Visit the **Ngrok** website.
* Sign up or log in.
* Open your dashboard.
* Copy your **Authorization Token**.

### Step 2 — Open Command Prompt

Navigate to your project folder.

```bash
cd path/to/RANDOMEET
```

### Step 3 — Authenticate Ngrok

Replace `<YOUR_TOKEN>` with your copied token.

```bash
ngrok authtoken <YOUR_TOKEN>
```

### Step 4 — Start the public server

```bash
npm run start:public
```

**Done.** Your **RANDOMEET** server will now be accessible through a public Ngrok URL, allowing users from anywhere to join and connect.

---

## Running the Project Locally

```bash
npm start
```

or

```bash
node server.js
```

Then open your browser:

```text
http://localhost:3000
```

## Usage

1. Open **RANDOMEET** in your browser.
2. Allow camera and microphone permissions.
3. Wait for another online user.
4. Start your conversation.
5. Click **Next** to meet a new stranger.

## Testing

```bash
npm test
```

or

```bash
node tests/run-tests.js
```

## Security

* Camera and microphone access always requires user permission.
* WebRTC creates peer-to-peer media connections whenever possible.
* Use HTTPS in production for maximum browser compatibility.

## Future Roadmap

* Text messaging
* AI moderation
* Interest-based matching
* User reporting system
* Multi-language support
* Authentication & profiles

## License

MIT License

---

**Built with Node.js, Express, and WebRTC.**
