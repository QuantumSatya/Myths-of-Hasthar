# Hasthar — Local Network Multiplayer

Play Hasthar with real friends in the same room, over your shared WiFi. No internet connection or accounts needed.

## Setup (one-time, on the host's computer)

1. Install Node.js if you don't have it: https://nodejs.org (LTS version)
2. Open a terminal in this folder and run:
   ```
   npm install
   ```

## Running a game

1. In this folder, run:
   ```
   npm start
   ```
2. The terminal will print something like:
   ```
   On this computer, open:   http://localhost:8080
   On other devices (same WiFi), open:
      http://192.168.1.23:8080
   ```
3. On the host's own computer, open the `localhost` link.
4. On every other player's phone or laptop (must be on the **same WiFi network**), open the `http://192.168.x.x:8080` link shown in the terminal.
5. The first person to connect becomes the **host** and sets up the game: number of players, how many of each card (Hasthar / Burglar / Goddess / Sacred Line), and Flour Dolls per player.
6. Once everyone configured has joined, the host clicks **Start Game**.
7. Play proceeds turn by turn — each player only ever sees their own hand. Everyone's Gold Coins, Flour Dolls, and card count are shown openly, same as before.
8. When the game ends, the host can click **New Game** to set up another round with the same group.

## Game Log

Click **Game Log** any time (from the lobby or during play) to see every game played on this server, plus the turns-vs-winner's-gold chart with mean/SD — downloadable as CSV or PNG. The log is saved to `game_log.json` in this folder and survives server restarts.

## Notes

- Everyone must stay on the same WiFi network as the host's computer while playing.
- If a player's browser refreshes or their phone locks, reopening the same link reconnects them to their same seat (their hand and progress are preserved).
- To stop the server, go back to the terminal and press `Ctrl+C`.
