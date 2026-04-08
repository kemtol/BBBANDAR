# PomPom.ai Frontend

A mobile‑first web interface for stock sentiment prediction, voting, and quiz.

This is a refactored version of the original React component (`pompom‑screens.jsx`) into a classic HTML/CSS/JS stack using **Bootstrap 5** and **jQuery**.

## Features

- **Dashboard**: Live countdown, hidden candidates preview, community stats.
- **Paywall**: Tier selection (Starter/Pro) with simulated purchase flow.
- **AI Quiz**: Interactive multiple‑choice questions with XP scoring and streaks.
- **Sentiment Battle**: Vote Bull/Bear on real‑time stock candidates, see live percentage bars.
- **Reveal**: Dramatic animated reveal of top 5 picks with audit trail.

## Tech Stack

- **HTML5** – Semantic markup, accessible structure.
- **Bootstrap 5** – Responsive grid, utility classes, components.
- **Custom CSS** – Dark theme with amber/green/red palette, custom components (badges, cards, buttons).
- **jQuery 3.6.0** – Screen management, interactive logic, animations.
- **Google Fonts** – Syne (display), JetBrains Mono (mono), DM Sans (body).

## Project Structure

```
src/frontend/
├── index.html          # Single‑page HTML with all screen sections
├── style.css           # Centralized styles (Bootstrap + custom)
├── index.js            # Centralized jQuery logic (navigation, quiz, voting, etc.)
└── pompom‑screens.jsx  # Original React component (kept for reference)
```

## Getting Started

1. **Serve the files** – Any static HTTP server can be used.
   ```bash
   # Example with Python
   python3 -m http.server 8080
   ```
2. Open `http://localhost:8080/workers/app‑sssaham‑pompom/src/frontend/index.html` in a browser.

No build step, no dependencies beyond CDN‑loaded Bootstrap and jQuery.

## Design Decisions

- **Single HTML file with toggled sections** – Mimics the original React SPA behavior without page reloads.
- **Centralized CSS** – All custom styles live in `style.css`, using CSS variables for theming.
- **jQuery for interactivity** – Lightweight, familiar, and sufficient for the required dynamic features.
- **Mobile‑first** – Maximum width 390px, fixed top/bottom navigation, optimized for mobile screens.
- **Bootstrap utilities** – Used for layout (grid, spacing) while custom CSS handles the unique visual identity.

## Screens

### Dashboard (`dashboard`)
- Countdown timer (simulated 16:59:00)
- Ticket status & community stats
- Hidden candidates preview with opacity grading

### Paywall (`paywall`)
- Tier cards with feature lists
- Fake purchase flow with loading state
- Success screen with activity suggestions

### Quiz (`quiz`)
- Three financial‑literacy questions
- Immediate feedback with explanations
- XP scoring, streak bonuses, progress bar

### Sentiment (`sentiment`)
- Candidate selector (BBYB, UCID, WIFI)
- Bull/Bear voting with real‑time percentage bar
- Community activity feed

### Reveal (`reveal`)
- Pre‑reveal dramatic countdown
- Animated sequential reveal of top 5 picks
- Audit‑trail badge for transparency

## Custom CSS Components

- `.badge‑pompom` – Small uppercase badges (amber, green, red, blue).
- `.card‑pompom` – Dark cards with subtle border and optional glow.
- `.btn‑pompom` – Gradient buttons (amber, green, red).
- `.pill‑button` – Toggle‑style pills.
- `.countdown‑timer` – Large amber digital timer.
- `.battle‑bar` – Sentiment percentage bar.

## JavaScript Modules

- **Screen manager** – Switches between sections, updates navigation.
- **Countdown timer** – Simulated countdown with hours/minutes/seconds.
- **Quiz engine** – Question flow, answer validation, scoring.
- **Voting system** – Records Bull/Bear votes, updates percentages.
- **Reveal animation** – Sequential reveal of picks with delay.

## Browser Support

Works in modern browsers (Chrome, Firefox, Safari, Edge) that support CSS Grid, Flexbox, and ES6.

## License

Part of the SSSAHAM project. Internal use.
