# **Rocket.Chat Standup Bot 🤖**

A Node.js bot for Rocket.Chat that automates daily standup meetings by prompting specific users for their status and publishing a summary to a designated channel.

This bot is designed to run in a Docker container, allowing for easy deployment and management.

### **Prerequisites**

To run this bot, you'll need the following installed:

* [Node.js](https://nodejs.org/) (for local development)  
* [npm](https://www.npmjs.com/) (installed with Node.js)  
* [Docker](https://www.docker.com/)  
* [Docker Compose](https://docs.docker.com/compose/)

### **Configuration**

All of the bot's configuration is managed through a **.env** file.

1. Create your configuration file by moving the provided example:  
   mv .env-example .env

2. Open **.env** in a text editor and fill in the values for your Rocket.Chat instance:  
   \# .env  
   \# Rocket.Chat URL, including the protocol (e.g., http:// or https://)  
   ROCKETCHAT\_URL=https://your-rocketchat-domain.com

   \# Bot user credentials  
   BOT\_USERNAME=your\_bot\_username  
   BOT\_PASSWORD=your\_bot\_password

   \# A comma-separated list of usernames that will participate in the standup.  
   \# The bot user should not be included in this list.  
   STANDUP\_USERS=dvanhoucke,johndoe,janedoe

   \# The name of the channel where the summary should be posted.  
   SUMMARY\_CHANNEL\_NAME=your\_summary\_channel\_name

   \# The cron schedule for when to prompt the standup.  
   \# Format: 'minute hour day\_of\_month month day\_of\_week'  
   \# '0 9 \* \* 1-5' means 9:00 AM on weekdays (Monday to Friday)  
   STANDUP\_TIME=0 9 \* \* 1-5

   \# The questions to ask the users. Separate each question with a semicolon.  
      # The questions to ask the users. Separate each question with a semicolon.  
   QUESTIONS=What did you work on yesterday?;What are you working on today?;Do you have any blockers?

   # The timeout in minutes to wait for the standup summary.
   SUMMARY_TIMEOUT_MINUTES=30

### **Building the Docker Image**

From the root directory of the project (where the Dockerfile is located), build the Docker image using the following command:

docker build \-t rocketchat-standup-bot .

This command builds the image and tags it with the name rocketchat-standup-bot.

### **Running with Docker Compose**

Use the provided docker-compose.yml file to easily run and manage your bot. This file mounts your external **.env** file into the container, so you can change configurations without rebuilding the image. Update the variable TZ to your timezone.

To start the bot, run the following command from the project root:

docker-compose up \-d

This command starts the bot in detached mode (-d), allowing it to run in the background.

To stop the bot, use:

docker-compose down

To restart the bot after making changes to your **.env** file, use:

docker-compose restart standup-bot  
