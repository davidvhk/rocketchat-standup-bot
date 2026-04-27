# Rocket.Chat Standup Bot 🤖

A robust Node.js bot for Rocket.Chat that automates daily standup meetings. It prompts specific users for their status, tracks progress persistently using MongoDB, and publishes a consolidated summary to a designated channel.

## ✨ Features

- **Automated Prompting**: Schedules standups via cron expressions.
- **Persistent Sessions**: MongoDB integration ensures progress is saved even if the bot restarts.
- **One Standup Per Day**: Strict validation to prevent duplicate submissions.
- **Manual Triggers**: Start your standup manually if you missed the prompt.
- **Diagnostic Commands**: Built-in `ping` and `status` for troubleshooting.
- **Docker Ready**: Easy deployment with Docker and Docker Compose.
- **CI/CD Verified**: Automated testing suite using Jest.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
- A [Rocket.Chat](https://rocket.chat/) instance and bot credentials.
- [MongoDB](https://www.mongodb.com/) (included in the Docker Compose setup).

### Configuration

The bot is configured via environment variables. Create a `.env` file from the example:

```bash
cp .env-example .env
```

Edit the `.env` file with your specific settings:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `ROCKETCHAT_URL` | Your Rocket.Chat instance URL | `https://chat.mycompany.com` |
| `BOT_USERNAME` | The username of the bot account | `standup.bot` |
| `BOT_PASSWORD` | The password for the bot account | `mypassword` |
| `STANDUP_USERS` | Comma-separated usernames to prompt | `alice,bob,charlie` |
| `SUMMARY_CHANNEL_NAME` | Channel where summaries are posted | `team-standup` |
| `STANDUP_TIME` | Cron schedule for the prompt | `0 9 * * 1-5` (9 AM weekdays) |
| `QUESTIONS` | Semicolon-separated questions | `Work yesterday?;Work today?;Blockers?` |
| `ADMIN_USERS` | Comma-separated usernames with admin rights | `david,admin.user` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://mongodb:27017/standupbot` |
| `SUMMARY_TIMEOUT_MINUTES`| Minutes to wait before posting summary | `30` |

---

## 🛠️ Deployment

### Using Docker Compose (Recommended)

The easiest way to run the bot along with a MongoDB instance:

1. **Start the services**:
   ```bash
   docker-compose up -d
   ```
2. **View logs**:
   ```bash
   docker-compose logs -f standup-bot
   ```
3. **Stop the services**:
   ```bash
   docker-compose down
   ```

### Manual Installation (Development)

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Run tests**:
   ```bash
   npm test
   ```
3. **Start the bot**:
   ```bash
   npm start
   ```

---

## 💬 Commands

### User Commands
Direct message the bot with these commands:

- `ping`: Check if the bot is responsive.
- `status`: Get a diagnostic report of your membership status, current session, and daily participation.
- `start standup`: Manually initiate your standup session for the day.
- `skip`: Opt-out of the current standup session.
- `vacation YYYY-MM-DD YYYY-MM-DD`: Set a vacation period. The bot will automatically skip your standups during these dates.
- `show vacation`: View your currently scheduled vacation period.
- `clear vacation`: Remove your scheduled vacation.

### Admin Commands 👑
Users listed in `ADMIN_USERS` can also use:

- `force summary`: Immediately compile and post the standup summary to the summary channel.
- `list users`: View all active standup members and their current session status.
- `delete standup @username`: Remove today's standup entry for a specific user, allowing them to redo it.
- `show standup @username YYYY-MM-DD`: View a specific historical standup entry for a user.

---

## 🧠 How it Works

### Session Persistence
The bot uses MongoDB to track standup participation. If a user starts a standup but doesn't finish, or if the bot restarts mid-session, the user can resume exactly where they left off by typing `start standup`.

### Daily Validation
Users are limited to one standup submission per calendar day. This prevents duplicate entries in the summary channel and ensures data integrity.

### Summary Posting
Once all active participants have completed their responses or the `SUMMARY_TIMEOUT_MINUTES` has elapsed, the bot compiles all answers into a clean, formatted message and posts it to the configured summary channel.

---

## 🧪 Testing

The project uses **Jest** for unit testing. The test suite mocks Rocket.Chat and MongoDB dependencies to verify:
- Logic for daily boundary checks.
- Command parsing and response.
- Session resumption logic.

Run tests locally:
```bash
npm test
```

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
