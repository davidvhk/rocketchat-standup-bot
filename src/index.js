// index.js
// A Rocket.Chat standup bot that prompts users for questions
// and publishes a summary.

// --- 1. Dependencies and Setup ---
// Load environment variables from a .env file
require('dotenv').config();

// Add global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]:', error);
  process.exit(1);
});

// TEMPORARY: Disable TLS validation for debugging
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Import the Rocket.Chat SDK
const { driver, api } = require('@rocket.chat/sdk');

// Import the scheduling library
const cron = require('node-cron');

// Import Mongoose for persistent storage
const mongoose = require('mongoose');

// --- 2. Database Schema ---
// Define the schema for storing standup responses.
const standupSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  date: { type: Date, default: Date.now },
  answers: [{
    question: String,
    answer: String,
    timestamp: { type: Date, default: Date.now }
  }],
  status: { type: String, enum: ['pending', 'answered', 'skipped'], default: 'pending' }
});

// Index to help with common queries (e.g., reports for a specific user or date)
standupSchema.index({ userId: 1, date: -1 });

const Standup = mongoose.model('Standup', standupSchema);

// A simple in-memory store to hold standup responses for the current day.
const standupResponses = new Map();

// Track the last question index sent to each user to prevent double-asking
const lastSentQuestionIndex = new Map();

// Cache to prevent processing the same message ID multiple times
const processedMessageIds = new Set();
const cacheMessageId = (id) => {
  processedMessageIds.add(id);
  if (processedMessageIds.size > 200) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
};

// --- 3. Environment Variables ---
// Retrieve all necessary variables from the .env file.
const ROCKCHAT_URL = process.env.ROCKETCHAT_URL;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const STANDUP_USERS = process.env.STANDUP_USERS.split(',').map(user => user.trim());
const SUMMARY_CHANNEL_NAME = process.env.SUMMARY_CHANNEL_NAME;
const STANDUP_TIME = process.env.STANDUP_TIME || '0 9 * * 1-5'; // Default to 9:00 AM on weekdays
const QUESTIONS_ARRAY = process.env.QUESTIONS.split(';').map(q => q.trim());
const SUMMARY_TIMEOUT_MINUTES = parseInt(process.env.SUMMARY_TIMEOUT_MINUTES, 10) || 30;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('[Error] MONGODB_URI is not defined in the environment or .env file.');
  process.exit(1);
}

// Global variables to store the channel IDs after lookup.
let SUMMARY_CHANNEL_ID;
let BOT_USER_ID;
let VALID_STANDUP_MEMBERS = [];

// --- 4. Core Bot Functions ---

/**
 * Gets the ID of a user by their username.
 * @param {string} username The username of the user.
 * @returns {string} The ID of the user.
 */
const getUserIdByUsername = async (username) => {
  try {
    console.log(`[getUserIdByUsername] Querying API for: ${username}`);
    const userInfo = await api.get('users.info', { username: username });
    
    if (userInfo && userInfo.user && userInfo.user._id) {
      console.log(`Found ID for user "${username}": ${userInfo.user._id}`);
      return userInfo.user._id;
    } else {
      console.log(`[getUserIdByUsername] API returned success but no user data for "${username}". Response:`, JSON.stringify(userInfo));
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
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // Timeout after 5 seconds if MongoDB is not reachable
    });
    console.log('Connected to MongoDB successfully!');

    console.log('Connecting to Rocket.Chat...');
    await driver.connect({ host: ROCKCHAT_URL, useSsl: ROCKCHAT_URL.startsWith('https') });
    console.log('Driver connected to Rocket.Chat. Attempting login...');
    const loginResult = await driver.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    
    // In this SDK version, driver.login returns the userId as a string.
    BOT_USER_ID = (typeof loginResult === 'object') ? (loginResult.userId || loginResult._id) : loginResult;
    console.log(`Logged in successfully! Bot User ID: ${BOT_USER_ID}`);

    // Explicitly log in the API module
    console.log('Logging in to API...');
    await api.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    console.log('API login successful.');
    
    // Fallback: If we still don't have the ID, get it from the API
    if (!BOT_USER_ID) {
      console.log('Bot User ID not found in login result, fetching from API...');
      const me = await api.get('me');
      BOT_USER_ID = me._id;
      console.log(`Bot User ID retrieved from 'me' API: ${BOT_USER_ID}`);
    }
    
    // Get the channel IDs from their names using the SDK's built-in methods
    console.log(`Looking up ID for channel: "${SUMMARY_CHANNEL_NAME}"`);
    try {
      SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);
      
      if (!SUMMARY_CHANNEL_ID) {
        console.error(`[Error] Could not find a channel named "${SUMMARY_CHANNEL_NAME}".`);
        console.error(`Please ensure the channel exists and that the bot user (@${BOT_USERNAME}) has been invited to it.`);
        process.exit(1);
      }
      
      console.log(`Found ID for channel "${SUMMARY_CHANNEL_NAME}": ${SUMMARY_CHANNEL_ID}`);
      
      // Attempt to join the room to ensure we can post to it
      console.log(`Attempting to join channel: ${SUMMARY_CHANNEL_NAME} (ID: ${SUMMARY_CHANNEL_ID})`);
      try {
        await driver.joinRoom(SUMMARY_CHANNEL_ID);
        console.log(`Successfully joined channel: ${SUMMARY_CHANNEL_NAME}`);
      } catch (joinErr) {
        console.log(`Note: Could not explicitly join ${SUMMARY_CHANNEL_NAME} (might be private or already joined): ${joinErr.message}`);
      }
    } catch (roomError) {
      console.error(`[Error] Room lookup/join failed for "${SUMMARY_CHANNEL_NAME}":`, roomError);
      process.exit(1);
    }

    // Check for user existence at startup
    console.log(`[connect] Checking existence for users: ${STANDUP_USERS.join(', ')}`);
    VALID_STANDUP_MEMBERS = []; // Reset to avoid duplicates on reconnect
    const uniqueUsernames = [...new Set(STANDUP_USERS)]; // Ensure unique usernames from config

    for (const username of uniqueUsernames) {
      if (username === BOT_USERNAME) {
        console.log(`[connect] Skipping bot user: ${username}`);
        continue;
      }
      console.log(`[connect] Looking up ID for user: ${username}`);
      const userId = await getUserIdByUsername(username);
      if (userId) {
        console.log(`[connect] Found user ${username} with ID: ${userId}`);
        // Ensure we don't add the same ID multiple times
        if (!VALID_STANDUP_MEMBERS.find(m => m._id === userId)) {
          VALID_STANDUP_MEMBERS.push({ _id: userId, username: username });
        }
      } else {
        console.log(`[connect] User "${username}" not found. Skipping.`);
      }
    }
    
    console.log(`[connect] Finished checking users. Valid members: ${VALID_STANDUP_MEMBERS.length}`);
    
    // Set up the Realtime API listener after successful login
    console.log('Setting up Realtime API listener...');
    await setupRealtimeApiListener();
    console.log('Realtime API listener setup complete.');
    console.log('Bot is fully connected and ready!');
  } catch (error) {
    console.error('Failed to connect and log in:', error.message);
    process.exit(1); // Exit if connection fails
  }
};

let isListenerSet = false;
/**
 * Sets up a listener for new direct messages using the Realtime API.
 */
const setupRealtimeApiListener = async () => {
  if (isListenerSet) {
    console.log('Listener already active, skipping setup.');
    return;
  }
  
  try {
    console.log('Subscribing to messages...');
    await driver.subscribeToMessages();

    driver.reactToMessages((err, message, messageOptions) => {
      if (err) {
        console.error('Error in Realtime API subscription:', err);
        return;
      }
      
      const senderId = message.u ? message.u._id : null;
      const senderUsername = message.u ? message.u.username : null;
      
      // Stricter bot detection
      const isBot = String(senderId) === String(BOT_USER_ID) || senderUsername === BOT_USERNAME;
      const isDM = messageOptions.roomType === 'd';
      
      if (senderId && !isBot && isDM && !message.editedAt && message.msg) {
        processStandupResponse(message);
      }
    });
    
    isListenerSet = true;
  } catch (error) {
    console.error('Failed to setup Realtime API listener:', error.message);
  }
};

/**
 * Sends a direct message to a specific user.
 * @param {object} member The full member object from the member list.
 * @param {string} text The message text to send.
 */
const sendDirectMessage = async (member, text) => {
  try {
    console.log(`[sendDirectMessage] Preparing message for ${member.username} (ID: ${member._id})`);
    
    // Create a DM room with the user's username
    const imCreateResult = await api.post('im.create', { username: member.username });
    console.log(`[sendDirectMessage] im.create result:`, JSON.stringify(imCreateResult));

    if (!imCreateResult || !imCreateResult.room) {
      throw new Error(`Failed to create DM room for ${member.username}`);
    }
    const dmRoomId = imCreateResult.room._id;
    console.log(`[sendDirectMessage] Target DM Room ID: ${dmRoomId}`);

    // Now send the message to the created/found DM room
    const result = await driver.sendToRoomId(text, dmRoomId);
    console.log(`[sendDirectMessage] Message sent successfully to ${member.username}`);
  } catch (error) {
    console.error(`[sendDirectMessage] Error:`, error.message);
  }
};

/**
 * Publishes a summary for a single user to the summary channel.
 * @param {string} userId The ID of the user.
 * @param {object} userResponse The user's response object.
 */
const publishIndividualSummary = async (userId, userResponse) => {
  try {
    console.log(`[publishIndividualSummary] Building summary for @${userResponse.username}`);
    
    let summaryText = `*Standup Summary for @${userResponse.username}*\n`;
    userResponse.answers.forEach((ans, i) => {
      summaryText += `> *${QUESTIONS_ARRAY[i]}*\n${ans}\n\n`;
    });

    // Use the highly reliable driver.sendToRoomId for the summary
    await driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
    console.log(`[publishIndividualSummary] Summary posted for @${userResponse.username}`);
  } catch (error) {
    console.error('[publishIndividualSummary] Error:', error.message);
  }
};

/**
 * Asks the next question to the user.
 * @param {string} userId The user's ID.
 * @param {object} userResponse The user's response object.
 */
const askNextQuestion = async (userId, userResponse) => {
  const currentQuestionIndex = userResponse.answers.length;
  
  // Prevent sending the same question twice in a row to the same user
  const lastIndex = lastSentQuestionIndex.get(userId);
  if (lastIndex === currentQuestionIndex && currentQuestionIndex < QUESTIONS_ARRAY.length) {
    console.log(`[askNextQuestion] Skipping duplicate question ${currentQuestionIndex + 1} for @${userResponse.username}`);
    return;
  }

  if (currentQuestionIndex < QUESTIONS_ARRAY.length) {
    const nextQuestion = QUESTIONS_ARRAY[currentQuestionIndex];
    console.log(`[askNextQuestion] Sending question ${currentQuestionIndex + 1}/${QUESTIONS_ARRAY.length} to @${userResponse.username}`);
    
    let messageText;
    if (currentQuestionIndex === 0) {
      messageText = `Hi ${userResponse.username}! It's time for today's standup. You can type **'skip'** at any time to skip.\n\n- ${nextQuestion}`;
    } else {
      messageText = `- ${nextQuestion}`;
    }

    lastSentQuestionIndex.set(userId, currentQuestionIndex);
    await sendDirectMessage({ _id: userId, username: userResponse.username }, messageText);
  } else {
    console.log(`[askNextQuestion] @${userResponse.username} completed. Publishing summary.`);
    userResponse.status = 'answered';
    
    // Clear the tracker for this user as they are finished
    lastSentQuestionIndex.delete(userId);

    await publishIndividualSummary(userId, userResponse);
    
    await sendDirectMessage(
      { _id: userId, username: userResponse.username }, 
      "Thank you! Your standup is complete."
    );
  }
};

/**
 * Retrieves the standup record for a user for the current calendar day.
 * @param {string} userId The user's ID.
 * @returns {Promise<object|null>} The standup document or null if none exists.
 */
const getStandupForToday = async (userId) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return await Standup.findOne({
    userId: userId,
    date: { $gte: startOfDay, $lte: endOfDay }
  });
};

/**
 * Prompts all users in the standup channel with the questions.
 */
const promptUsersForStandup = async () => {
  console.log(`\n--- Starting daily standup for specified users ---`);
  standupResponses.clear(); // Clear previous session responses
  
  try {
    const validMembers = VALID_STANDUP_MEMBERS;

    console.log(`[promptUsersForStandup] Found ${validMembers.length} valid members for standup.`);

    if (validMembers && validMembers.length > 0) {
      for (const member of validMembers) {
        console.log(`[promptUsersForStandup] Checking existing status for member: ${member.username}`);
        
        // 1. Check if they already have an entry for today
        const existingStandup = await getStandupForToday(member._id);
        
        if (existingStandup) {
          if (existingStandup.status === 'answered' || existingStandup.status === 'skipped') {
            console.log(`[promptUsersForStandup] User @${member.username} has already ${existingStandup.status} today. Skipping.`);
            continue;
          } else if (existingStandup.status === 'pending') {
            console.log(`[promptUsersForStandup] User @${member.username} has a pending standup. Resuming.`);
            // Restore progress into memory
            const userSession = {
              username: member.username,
              answers: existingStandup.answers.map(a => a.answer),
              status: 'pending',
              dbId: existingStandup._id
            };
            standupResponses.set(member._id, userSession);
            await askNextQuestion(member._id, userSession);
            continue;
          }
        }

        console.log(`[promptUsersForStandup] Preparing to prompt member: ${member.username}`);
        
        // Initialize the user's entry in our temporary store
        const userSession = {
          username: member.username,
          answers: [],
          status: 'pending'
        };
        standupResponses.set(member._id, userSession);

        // Create a new record in MongoDB for this session
        const standup = new Standup({
          userId: member._id,
          username: member.username,
          status: 'pending',
          answers: []
        });
        await standup.save();
        userSession.dbId = standup._id; // Store reference to update later

        // Ask the first question
        await askNextQuestion(member._id, userSession);
        
        // Add a delay to avoid rate-limiting
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } else {
      console.log('[promptUsersForStandup] No members found for the specified list.');
    }
    
    // Schedule final summary
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
  let hasContent = false;
  
  if (standupResponses.size === 0) {
    summaryText += 'No standup responses were collected today.';
    hasContent = true;
  } else {
    for (const [userId, data] of standupResponses.entries()) {
      if (data.status === 'skipped') {
        summaryText += `@${data.username}: Skipped the standup.\n\n`;
        hasContent = true;
      } else if (data.status === 'pending') {
        summaryText += `@${data.username}: Did not respond.\n\n`;
        hasContent = true;
      }
    }
  }

  if (hasContent) {
    try {
      await driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
      console.log('[publishStandupSummary] Final summary published successfully!');
    } catch (error) {
      console.error('[publishStandupSummary] Failed to publish summary:', error.message);
    }
  }
};

/**
 * Process incoming DM messages and them as standup responses.
 * @param {object} message The message object from the Realtime API.
 */
const processStandupResponse = async (message) => {
  const userId = message.u._id;
  const text = message.msg;
  const username = message.u.username;

  if (!text) return;
  
  // Prevent duplicate processing
  if (processedMessageIds.has(message._id)) return;
  cacheMessageId(message._id);

  // Stricter bot detection
  if (String(userId) === String(BOT_USER_ID) || username === BOT_USERNAME) return;

  console.log(`[Message Received] From @${username}: "${text}"`);

  // Handle Diagnostic Commands
  const cleanText = text.toLowerCase().trim();
  
  if (cleanText === 'ping') {
    await sendDirectMessage({ _id: userId, username: username }, 'Pong! 🏓 I am alive and listening.');
    return;
  }

  if (cleanText === 'status') {
    const isMember = VALID_STANDUP_MEMBERS.some(m => m._id === userId);
    const session = standupResponses.get(userId);
    const dbEntry = await getStandupForToday(userId);

    let statusMsg = `*Bot Status Check*\n`;
    statusMsg += `- Your Username: @${username}\n`;
    statusMsg += `- Your User ID: ${userId}\n`;
    statusMsg += `- Is Standup Member: ${isMember ? 'Yes ✅' : 'No ❌'}\n`;
    statusMsg += `- Active Session: ${session ? `Yes (${session.status})` : 'None'}\n`;
    statusMsg += `- Today's DB Record: ${dbEntry ? `${dbEntry.status} ✅` : 'None ❌'}\n`;
    statusMsg += `- Bot Local Time: ${new Date().toString()}\n`;
    statusMsg += `- Configured Schedule: ${STANDUP_TIME}\n`;
    
    if (!isMember) {
      statusMsg += `\n_Note: You are not in the STANDUP_USERS list in the .env file._`;
    }
    
    await sendDirectMessage({ _id: userId, username: username }, statusMsg);
    return;
  }

  // Handle Standup Logic
  let userSession = standupResponses.get(userId);
  
  if (cleanText === 'start standup') {
    const member = VALID_STANDUP_MEMBERS.find(m => m._id === userId);
    
    if (!member) {
      await sendDirectMessage({ _id: userId, username: username }, 'Sorry, you are not configured to participate in the standup.');
      return;
    }

    // Check database for existing record today
    const existingStandup = await getStandupForToday(userId);
    
    if (existingStandup) {
      if (existingStandup.status === 'answered' || existingStandup.status === 'skipped') {
        await sendDirectMessage({ _id: userId, username: username }, `You have already ${existingStandup.status} today's standup.`);
        return;
      }
      
      if (existingStandup.status === 'pending' && !userSession) {
        console.log(`[Manual Trigger] Resuming pending session for @${username}`);
        userSession = {
          username: username,
          answers: existingStandup.answers.map(a => a.answer),
          status: 'pending',
          dbId: existingStandup._id
        };
        standupResponses.set(userId, userSession);
      }
    }

    if (!userSession) {
      console.log(`[Manual Trigger] Initializing new session for @${username}`);
      userSession = {
        username: username,
        answers: [],
        status: 'pending'
      };
      standupResponses.set(userId, userSession);

      // Create DB record
      const standup = new Standup({
        userId: userId,
        username: username,
        status: 'pending',
        answers: []
      });
      await standup.save();
      userSession.dbId = standup._id;
    }

    await askNextQuestion(userId, userSession);
    return;
  }

  // If no session exists, ignore other messages
  if (!userSession) return;

  // Ignore messages if the user has already finished or skipped
  if (userSession.status === 'answered' || userSession.status === 'skipped') return;

  // Prevent concurrent processing
  if (userSession.isProcessing) return;
  userSession.isProcessing = true;

  try {
    if (cleanText === 'skip') {
      userSession.status = 'skipped';
      await Standup.findByIdAndUpdate(userSession.dbId, { status: 'skipped' }).catch(e => console.error('DB Skip update failed:', e.message));
      
      console.log(`@${userSession.username} skipped the standup.`);
      await sendDirectMessage({ _id: userId, username: userSession.username }, 'You have skipped today\'s standup. Thank you.');
      await driver.sendToRoomId(`@${userSession.username} has skipped his standup.`, SUMMARY_CHANNEL_ID);
    } else {
      const questionIndex = userSession.answers.length;
      
      if (questionIndex >= QUESTIONS_ARRAY.length) {
        userSession.status = 'answered';
        return;
      }

      const currentQuestion = QUESTIONS_ARRAY[questionIndex];
      userSession.answers.push(text);
      
      const isFinished = userSession.answers.length === QUESTIONS_ARRAY.length;
      console.log(`[Response] @${userSession.username} answered ${userSession.answers.length}/${QUESTIONS_ARRAY.length}`);

      // Save answer to MongoDB
      await Standup.findByIdAndUpdate(userSession.dbId, {
        $push: { answers: { question: currentQuestion, answer: text } },
        status: isFinished ? 'answered' : 'pending'
      }).catch(dbError => console.error('Error saving to MongoDB:', dbError.message));

      if (isFinished) {
        userSession.status = 'answered';
      }

      await askNextQuestion(userId, userSession);
    }
  } catch (error) {
    console.error('Error in processStandupResponse:', error.message);
  } finally {
    userSession.isProcessing = false;
  }
};

// --- 4. Main Execution ---

/**
 * Initializes the bot and schedules the cron tasks.
 */
const start = async () => {
  console.log('--- Starting Standup Bot ---');
  console.log(`Current server time: ${new Date().toString()}`);
  
  try {
    // 1. Connect and initialize everything
    await connect();
    
    // 2. Schedule the daily standup
    let cronPattern = STANDUP_TIME.replace('1-7', '*');
    
    // Ensure 6 fields (seconds minute hour dom month dow)
    const fields = cronPattern.split(' ');
    if (fields.length === 5) {
      cronPattern = '0 ' + cronPattern;
    }

    // Schedule the standup
    cron.schedule(cronPattern, () => {
      console.log(`[Cron] Triggering daily standup at ${new Date().toString()}`);
      promptUsersForStandup();
    });

    // Add a heartbeat log every minute to verify the clock and scheduler
    cron.schedule('0 * * * * *', () => {
      console.log(`[Heartbeat] Bot time: ${new Date().toLocaleTimeString()} | Users: ${VALID_STANDUP_MEMBERS.length}`);
    });

    console.log(`\n✅ Standup bot is fully ready!`);
    console.log(`- Bot Time: ${new Date().toString()}`);
    console.log(`- Scheduled: ${cronPattern}`);
    console.log(`- Valid members: ${VALID_STANDUP_MEMBERS.map(m => m.username).join(', ')}`);
  } catch (err) {
    console.error('CRITICAL: Failed during startup sequence:', err);
    process.exit(1);
  }
};

// Launch the application
if (require.main === module) {
  start();
}

// Export for testing
module.exports = {
  getStandupForToday,
  promptUsersForStandup,
  processStandupResponse,
  standupResponses,
  Standup,
  VALID_STANDUP_MEMBERS
};

