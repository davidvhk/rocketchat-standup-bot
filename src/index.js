// index.js
// A Rocket.Chat standup bot that prompts users for questions
// and publishes a summary.

// --- 1. Dependencies and Setup ---
// Load environment variables from a .env file
require('dotenv').config();

// Import the Rocket.Chat SDK
const { driver, api } = require('@rocket.chat/sdk');

// Import the scheduling library
const cron = require('node-cron');

// A simple in-memory store to hold standup responses for the current day.
// This will be reset each day. For a more robust solution, use a database.
const standupResponses = new Map();

// --- 2. Environment Variables ---
// Retrieve all necessary variables from the .env file.
const ROCKCHAT_URL = process.env.ROCKETCHAT_URL;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const STANDUP_USERS = process.env.STANDUP_USERS.split(',').map(user => user.trim());
const SUMMARY_CHANNEL_NAME = process.env.SUMMARY_CHANNEL_NAME;
const STANDUP_TIME = process.env.STANDUP_TIME || '0 9 * * 1-5'; // Default to 9:00 AM on weekdays
const QUESTIONS_ARRAY = process.env.QUESTIONS.split(';').map(q => q.trim());
const SUMMARY_TIMEOUT_MINUTES = parseInt(process.env.SUMMARY_TIMEOUT_MINUTES, 10) || 30;

// Global variables to store the channel IDs after lookup.
let SUMMARY_CHANNEL_ID;
let BOT_USER_ID;
let VALID_STANDUP_MEMBERS = [];

// --- 3. Core Bot Functions ---

/**
 * Gets the ID of a user by their username.
 * @param {string} username The username of the user.
 * @returns {string} The ID of the user.
 */
const getUserIdByUsername = async (username) => {
  try {
    const userInfo = await api.get('users.info', { username: username });
    if (userInfo && userInfo.user && userInfo.user._id) {
      console.log(`Found ID for user "${username}": ${userInfo.user._id}`);
      return userInfo.user._id;
    }
  } catch (error) {
    console.error(`Error finding user ID for "${username}":`, error.message);
  }
  return null;
};


/**
 * Connects the bot to the Rocket.Chat server and logs in.
 */
const connect = async () => {
  try {
    console.log('Connecting to Rocket.Chat...');
    await driver.connect({ host: ROCKCHAT_URL, useSsl: ROCKCHAT_URL.startsWith('https') });
    const loginResult = await driver.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    BOT_USER_ID = loginResult.userId;
    console.log('Logged in successfully!');

    // Explicitly log in the API module to prevent it from using default credentials.
    await api.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    
    // Get the channel IDs from their names using the SDK's built-in methods
    SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);

    if (!SUMMARY_CHANNEL_ID) {
      console.error(`Could not find a channel named "${SUMMARY_CHANNEL_NAME}". Exiting.`);
      process.exit(1);
    }

    // Check for user existence at startup
    console.log(`[connect] Checking existence for users: ${STANDUP_USERS.join(', ')}`);
    for (const username of STANDUP_USERS) {
      if (username === BOT_USERNAME) {
        console.log(`[connect] Skipping bot user: ${username}`);
        continue;
      }
      const userId = await getUserIdByUsername(username);
      if (userId) {
        VALID_STANDUP_MEMBERS.push({ _id: userId, username: username });
      } else {
        console.log(`[connect] User "${username}" not found. Skipping.`);
      }
    }
    
    // Set up the Realtime API listener after successful login
    setupRealtimeApiListener();
  } catch (error) {
    console.error('Failed to connect and log in:', error.message);
    process.exit(1); // Exit if connection fails
  }
};

/**
 * Sets up a listener for new direct messages using the Realtime API.
 */
const setupRealtimeApiListener = async () => {
  try {
    console.log('Subscribing to direct messages...');
    
    // Subscribe to messages in the bot's direct message stream
    await driver.subscribeToMessages();

    // Set up the message processing callback
    driver.reactToMessages((err, message, messageOptions) => {
      if (err) {
        console.error('Error in Realtime API subscription:', err);
        return;
      }
      
      // We only care about new messages in the DM stream from other users
      if (message.u && message.u._id !== BOT_USER_ID && messageOptions.roomType === 'd' && !message.editedAt) {
        console.log(`Received message from ${message.u.username} in DM.`);
        processStandupResponse(message);
      }
    });
    
  } catch (error) {
    console.error('Failed to subscribe to Realtime API:', error.message);
  }
};

/**
 * Sends a direct message to a specific user.
 * @param {object} member The full member object from the member list.
 * @param {string} text The message text to send.
 */
const sendDirectMessage = async (member, text) => {
  try {
    console.log(`[sendDirectMessage] Attempting to create DM channel for user: ${member.username} (ID: ${member._id})`);
    
    // Create a DM room with the user's username
    const imCreateResult = await api.post('im.create', { username: member.username });
    const dmRoomId = imCreateResult.room._id;
    console.log(`[sendDirectMessage] Created/found DM room with ID: ${dmRoomId}`);

    // Now send the message to the created/found DM room
    const result = await driver.sendToRoomId(text, dmRoomId);
    console.log(`[sendDirectMessage] Sent DM to user: ${member.username}`);
    console.log(`[sendDirectMessage] sendDirectToUser result:`, result);
  } catch (error) {
    console.error(`[sendDirectMessage] Failed to send DM to ${member.username}:`, error.message);
  }
};

/**
 * Publishes a summary for a single user to the summary channel.
 * @param {string} userId The ID of the user.
 * @param {object} userResponse The user's response object.
 */
const publishIndividualSummary = async (userId, userResponse) => {
  // Use Rocket.Chat's attachments API to create a colored message block.
  const attachments = userResponse.answers.map((ans, i) => {
    let color;
    // Assign a different color for each question
    switch(i) {
      case 0:
        color = '#00BFFF'; // Blue
        break;
      case 1:
        color = '#32CD32'; // Green
        break;
      case 2:
        color = '#FFD700'; // Gold
        break;
      default:
        color = '#808080'; // Grey
    }

    // Replace literal '\n' characters with escaped newlines for the API payload
    const formattedAnswer = ans.replace(/\n/g, '\\\n');
    
    return {
      color: color,
      title: QUESTIONS_ARRAY[i],
      text: formattedAnswer
    };
  });
  
  try {
    console.log(`[publishIndividualSummary] Attempting to publish summary for ${userResponse.username} to room ID: ${SUMMARY_CHANNEL_ID}`);
    // Use the api.post method with the chat.postMessage endpoint for attachments
    const result = await api.post('chat.postMessage', {
      channel: SUMMARY_CHANNEL_ID,
      text: `--- @${userResponse.username} has completed his standup ---`,
      attachments: attachments
    });
    console.log('[publishIndividualSummary] Individual summary published successfully!', result);
  } catch (error) {
    console.error('[publishIndividualSummary] Failed to publish summary:', error.message);
  }
};

/**
 * Asks the next question to the user.
 * @param {string} userId The user's ID.
 * @param {object} userResponse The user's response object.
 */
const askNextQuestion = async (userId, userResponse) => {
  const currentQuestionIndex = userResponse.answers.length;
  if (currentQuestionIndex < QUESTIONS_ARRAY.length) {
    const nextQuestion = QUESTIONS_ARRAY[currentQuestionIndex];
    let messageText;
    if (currentQuestionIndex === 0) {
      // Add the "skip" instruction to the very first question
      messageText = `Hi ${userResponse.username}! It's time for today's standup. You can type **'skip'** at any time to skip. Please note that answers **cannot** be edited.

- ${nextQuestion}`;
    } else {
      messageText = `- ${nextQuestion}`;
    }
    await sendDirectMessage({ _id: userId, username: userResponse.username }, messageText);
  } else {
    // All questions answered, publish the summary for this user.
    userResponse.status = 'answered';
    await publishIndividualSummary(userId, userResponse);
  }
};

/**
 * Prompts all users in the standup channel with the questions.
 */
const promptUsersForStandup = async () => {
  console.log(`\n--- Starting daily standup for specified users ---`);
  standupResponses.clear(); // Clear previous responses
  
  try {
    const validMembers = VALID_STANDUP_MEMBERS;

    console.log(`[promptUsersForStandup] Found ${validMembers.length} valid members for standup.`);
    console.log(`[promptUsersForStandup] Member list:`, validMembers.map(m => m.username));

    if (validMembers && validMembers.length > 0) {
      for (const member of validMembers) {
        
        console.log(`[promptUsersForStandup] Preparing to prompt member: ${member.username} (ID: ${member._id})`);
        
        // Initialize the user's entry in our temporary store
        const userResponse = {
          username: member.username,
          questions: QUESTIONS_ARRAY.slice(), // Store a copy of the questions
          answers: [],
          status: 'pending' // pending, answered, skipped
        };
        standupResponses.set(member._id, userResponse);

        // Ask the first question
        await askNextQuestion(member._id, userResponse);
        
        // Add a 5-second delay to avoid rate-limiting
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } else {
      console.log('[promptUsersForStandup] No members found for the specified list.');
    }
    
    // A final summary for non-respondents will still be published at the end.
    const summaryScheduleTime = new Date(Date.now() + SUMMARY_TIMEOUT_MINUTES * 60 * 1000);
    console.log(`[promptUsersForStandup] Final standup summary scheduled for: ${summaryScheduleTime.toLocaleTimeString()}`);
    setTimeout(publishStandupSummary, SUMMARY_TIMEOUT_MINUTES * 60 * 1000);
    
  } catch (error) {
    console.error('[promptUsersForStandup] Failed to prompt users:', error.message);
  }
};

/**
 * Compiles and publishes the final standup summary for non-respondents.
 */
const publishStandupSummary = async () => {
  console.log(`\n--- Publishing final standup summary for channel ${SUMMARY_CHANNEL_NAME} ---`);
  
  let summaryText = 'Daily Standup Summary\n\n';
  
  if (standupResponses.size === 0) {
    summaryText += 'No standup responses were collected today.';
  } else {
    standupResponses.forEach((data, userId) => {
      if (data.status === 'skipped') {
        summaryText += `@${data.username}: Skipped the standup.\n\n`;
      } else if (data.status === 'pending') {
        // Only publish for users who didn't respond at all.
        summaryText += `@${data.username}: Did not respond.\n\n`;
      }
      // 'answered' status users are handled by the individual summary function
    });
  }

  // Only post if there are non-respondents or skipped users to report.
  if (summaryText !== 'Daily Standup Summary\n\n') {
    try {
      console.log(`[publishIndividualSummary] Attempting to publish final summary to room ID: ${SUMMARY_CHANNEL_ID}`);
      await driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
      console.log('[publishIndividualSummary] Final summary published successfully!');
    } catch (error) {
      console.error('[publishIndividualSummary] Failed to publish summary:', error.message);
    }
  } else {
    console.log('[publishIndividualSummary] All users responded. No final summary needed.');
  }
};

/**
 * Process incoming DM messages and them as standup responses.
 * @param {object} message The message object from the Realtime API.
 */
const processStandupResponse = (message) => {
  const userId = message.u._id;
  const userResponse = standupResponses.get(userId);
  
  // Check if we are currently expecting a standup response from this user
  if (userResponse && userResponse.status === 'pending') {
    const text = message.msg; // No need to trim or lowercase here, as we're saving the full message
    
    if (text.toLowerCase().trim() === 'skip') {
      userResponse.status = 'skipped';
      console.log(`@${userResponse.username} skipped the standup.`);
      // Send a confirmation and then publish the summary of the skip
      sendDirectMessage({ _id: userId, username: userResponse.username }, 'You have skipped today\'s standup. Thank you.');
      
      let summaryText = `@${userResponse.username} has skipped his standup.`;
      driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
    } else {
      userResponse.answers.push(text); // Store the user's full answer.
      console.log(`@${userResponse.username} answered question ${userResponse.answers.length}.`);
      
      // Ask the next question
      askNextQuestion(userId, userResponse);
    }
  }
};

// --- 4. Main Execution ---
// Schedule the standup to run at the configured time and days.
// The syntax is 'minute hour day_of_month month day_of_week'
// Example: '0 9 * * 1-5' means 9:00 AM on Monday through Friday
cron.schedule(STANDUP_TIME, promptUsersForStandup);

// Connect to Rocket.Chat on application start
connect();

// Keep the Node.js process running for the cron scheduler
console.log(`Standup bot is running. It will prompt for standup at: ${STANDUP_TIME}`);

