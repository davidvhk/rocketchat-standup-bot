// index.js
// A Rocket.Chat standup bot that prompts users for questions
// and publishes a summary.

// --- 1. Dependencies and Setup ---
// Load environment variables from a .env file
require('dotenv').config();
const { version: BOT_VERSION } = require('../package.json');

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
  status: { type: String, enum: ['pending', 'answered', 'skipped'], default: 'pending' },
  snoozeUntil: { type: Date, default: null }
});

// Index to help with common queries (e.g., reports for a specific user or date)
standupSchema.index({ userId: 1, date: -1 });

const Standup = mongoose.model('Standup', standupSchema);

// Schema for user vacations
const vacationSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true }
});

const Vacation = mongoose.model('Vacation', vacationSchema);

// Schema for bot configuration
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const Config = mongoose.model('Config', configSchema);

// Schema for members and their roles
const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  isStandupMember: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false }
});

const Member = mongoose.model('Member', memberSchema);

// Schema for muted dates (holidays/days off)
const muteSchema = new mongoose.Schema({
  date: { type: Date, required: true, unique: true },
  reason: { type: String, default: 'Holiday/Day Off' },
  addedBy: { type: String }
});

const Mute = mongoose.model('Mute', muteSchema);

// A simple in-memory store to hold standup responses for the current day.
const standupResponses = new Map();

// Track the last question index sent to each user to prevent double-asking
const lastSentQuestionIndex = new Map();

// Reference to the active cron task for the daily standup
let standupCronTask;

// Cache to prevent processing the same message ID multiple times
const processedMessageIds = new Set();
const cacheMessageId = (id) => {
  processedMessageIds.add(id);
  if (processedMessageIds.size > 200) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
};

/**
 * Formats a Date object to YYYY-MM-DD in local time.
 * @param {Date} date The date to format.
 * @returns {string} The formatted date string.
 */
const formatLocalDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Parses a YYYY-MM-DD string into a Date object at local midnight.
 * @param {string} dateStr The date string to parse.
 * @returns {Date} The parsed Date object.
 */
const parseLocalDate = (dateStr) => {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
};

/**
 * Returns a color hex code based on the status.
 * @param {string} status The status ('answered', 'skipped', 'pending').
 * @returns {string} The hex color code.
 */
const getColor = (status) => {
  switch (status) {
    case 'answered': return '#2de0a5'; // Green
    case 'skipped': return '#ffc107'; // Yellow/Orange
    case 'pending': return '#f5455c'; // Red
    default: return '#cbced1'; // Grey
  }
};

/**
 * Returns a color for a specific question index to make the summary colorful.
 * @param {number} index The question index.
 * @returns {string} Hex color code.
 */
const getQuestionColor = (index) => {
  const palette = [
    '#2de0a5', // Green
    '#1d74f5', // Blue
    '#ffa12f', // Orange
    '#642afb', // Purple
    '#f5455c'  // Red
  ];
  return palette[index % palette.length];
};

// --- 3. Environment Variables ---
// Retrieve all necessary variables from the .env file.
const ROCKCHAT_URL = process.env.ROCKETCHAT_URL;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const STANDUP_USERS = (process.env.STANDUP_USERS || '').split(',').map(user => user.trim()).filter(Boolean);
const SUMMARY_CHANNEL_NAME = process.env.SUMMARY_CHANNEL_NAME;
const STANDUP_TIME = process.env.STANDUP_TIME || '0 9 * * 1-5'; // Default to 9:00 AM on weekdays
let currentStandupTime = STANDUP_TIME;
const QUESTIONS_ARRAY = (process.env.QUESTIONS || '').split(';').map(q => q.trim()).filter(Boolean);
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(user => user.trim()).filter(Boolean);
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
let ADMIN_USER_IDS = [];

// --- 4. Core Bot Functions ---

/**
 * Schedules or re-schedules the daily standup cron task.
 * @param {string} pattern The cron pattern.
 */
const scheduleStandup = (pattern) => {
  if (standupCronTask) {
    console.log('[scheduleStandup] Stopping existing cron task...');
    standupCronTask.stop();
  }

  currentStandupTime = pattern;
  let cronPattern = pattern.replace('1-7', '*');
  
  // Ensure 6 fields (seconds minute hour dom month dow)
  const fields = cronPattern.split(' ');
  if (fields.length === 5) {
    cronPattern = '0 ' + cronPattern;
  }

  console.log(`[scheduleStandup] Scheduling daily standup with pattern: "${cronPattern}"`);
  standupCronTask = cron.schedule(cronPattern, () => {
    console.log(`[Cron] Triggering daily standup at ${new Date().toString()}`);
    promptUsersForStandup();
  });
};

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
 * Refreshes the in-memory VALID_STANDUP_MEMBERS and ADMIN_USER_IDS from the database.
 */
const refreshMembers = async () => {
  const allMembers = await Member.find({});
  
  VALID_STANDUP_MEMBERS.length = 0;
  const newMembers = allMembers
    .filter(m => m.isStandupMember)
    .map(m => ({ _id: m.userId, username: m.username }));
  VALID_STANDUP_MEMBERS.push(...newMembers);

  ADMIN_USER_IDS.length = 0;
  const newAdmins = allMembers
    .filter(m => m.isAdmin)
    .map(m => m.userId);
  ADMIN_USER_IDS.push(...newAdmins);
  
  console.log(`[refreshMembers] Members: ${VALID_STANDUP_MEMBERS.length}, Admins: ${ADMIN_USER_IDS.length}`);
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

    // Initialize members from environment variables if the database is empty
    const memberCount = await Member.countDocuments();
    if (memberCount === 0) {
      console.log('[connect] Member collection is empty. Bootstrapping from environment variables...');
      
      const uniqueUsernames = [...new Set([...STANDUP_USERS, ...ADMIN_USERS])];
      for (const username of uniqueUsernames) {
        if (username === BOT_USERNAME) continue;
        
        // We need to login to API first to look up user IDs
      }
      // Actually we need to log in to RocketChat first before we can lookup IDs.
      // So we will do the bootstrapping AFTER login.
    }

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
    
    // Bootstrap members if empty
    if (await Member.countDocuments() === 0) {
      console.log('[connect] Bootstrapping members from env vars...');
      const uniqueUsernames = [...new Set([...STANDUP_USERS, ...ADMIN_USERS])];
      for (const uname of uniqueUsernames) {
        if (uname === BOT_USERNAME) continue;
        const uid = await getUserIdByUsername(uname);
        if (uid) {
          await Member.findOneAndUpdate(
            { userId: uid },
            { 
              userId: uid, 
              username: uname, 
              isStandupMember: STANDUP_USERS.includes(uname),
              isAdmin: ADMIN_USERS.includes(uname)
            },
            { upsert: true }
          );
        }
      }
    }

    await refreshMembers();
    
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

    if (!imCreateResult || !imCreateResult.room) {
      throw new Error(`Failed to create DM room for ${member.username}`);
    }
    const dmRoomId = imCreateResult.room._id;

    // Now send the message to the created/found DM room
    await driver.sendToRoomId(text, dmRoomId);
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
    
    const attachments = [];
    
    // 1. Header attachment
    attachments.push({
      color: getColor(userResponse.status),
      text: `🔔 *Standup Summary for @${userResponse.username}*`,
      ts: new Date().toISOString()
    });

    // 2. One attachment per question for colorful display
    userResponse.answers.forEach((ans, i) => {
      attachments.push({
        color: getQuestionColor(i),
        title: QUESTIONS_ARRAY[i],
        text: ans
      });
    });

    await api.post('chat.postMessage', {
      roomId: SUMMARY_CHANNEL_ID,
      attachments: attachments,
      text: `_Bot version: ${BOT_VERSION}_`
    });

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
      messageText = `Hi ${userResponse.username}! It's time for today's standup. You can type **'skip'** to skip or **'snooze [minutes]'** to delay.\n\n- ${nextQuestion}`;
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
 * Checks if a user is currently on vacation.
 * @param {string} userId The user's ID.
 * @returns {Promise<boolean>} True if the user is on vacation today.
 */
const isUserOnVacation = async (userId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const vacation = await Vacation.findOne({
    userId: userId,
    startDate: { $lte: today },
    endDate: { $gte: today }
  });

  return !!vacation;
};

/**
 * Checks for users whose snooze period has expired and re-prompts them.
 */
const checkSnoozes = async () => {
  const now = new Date();
  try {
    const expiredSnoozes = await Standup.find({
      status: 'pending',
      snoozeUntil: { $lte: now }
    });

    for (const record of expiredSnoozes) {
      console.log(`[checkSnoozes] Snooze expired for @${record.username}. Re-prompting.`);
      
      // Update DB to clear snooze
      await Standup.findByIdAndUpdate(record._id, { snoozeUntil: null });

      // Restore session in memory
      const userSession = {
        username: record.username,
        answers: record.answers.map(a => a.answer),
        status: 'pending',
        dbId: record._id
      };
      standupResponses.set(record.userId, userSession);

      // Re-prompt
      await sendDirectMessage({ _id: record.userId, username: record.username }, "⏰ *Snooze over!* Let's continue your standup.");
      await askNextQuestion(record.userId, userSession);
    }
  } catch (err) {
    console.error('[checkSnoozes] Error:', err.message);
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
 * Loads all standup records for the current day from MongoDB into the in-memory store.
 * This ensures the bot can resume sessions and generate accurate summaries after a restart.
 */
const loadTodaySessions = async () => {
  console.log('[loadTodaySessions] Restoring today\'s sessions from MongoDB...');
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const todaysStandups = await Standup.find({
      date: { $gte: startOfDay, $lte: endOfDay }
    });

    console.log(`[loadTodaySessions] Found ${todaysStandups.length} records for today.`);

    todaysStandups.forEach(record => {
      const userSession = {
        username: record.username,
        answers: record.answers.map(a => a.answer),
        status: record.status,
        dbId: record._id
      };
      standupResponses.set(record.userId, userSession);
      console.log(`[loadTodaySessions] Restored session for @${record.username} (${record.status})`);
    });
  } catch (error) {
    console.error('[loadTodaySessions] Failed to load sessions:', error.message);
  }
};

/**
 * Prompts all users in the standup channel with the questions.
 */
const promptUsersForStandup = async () => {
  console.log(`\n--- Starting daily standup for specified users ---`);
  
  try {
    // 1. Check if today is muted
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const muteRecord = await Mute.findOne({ date: today });
    
    if (muteRecord) {
      console.log(`[promptUsersForStandup] Today is muted: ${muteRecord.reason}. Skipping prompts.`);
      await api.post('chat.postMessage', {
        roomId: SUMMARY_CHANNEL_ID,
        text: `🔕 *Standup Muted Today*\nReason: ${muteRecord.reason}\n_Enjoy your day off!_ 🌴`
      });
      return;
    }

    standupResponses.clear(); // Clear previous session responses
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

        // 2. Check for vacation
        const onVacation = await isUserOnVacation(member._id);
        if (onVacation) {
          console.log(`[promptUsersForStandup] User @${member.username} is on vacation. Automatically skipping.`);
          const userSession = {
            username: member.username,
            answers: [],
            status: 'skipped'
          };
          standupResponses.set(member._id, userSession);

          const standup = new Standup({
            userId: member._id,
            username: member.username,
            status: 'skipped',
            answers: [{ question: 'Auto-skipped', answer: 'On vacation 🌴' }]
          });
          await standup.save();
          userSession.dbId = standup._id;
          continue;
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
  
  const attachments = [];
  
  if (standupResponses.size === 0) {
    attachments.push({
      color: getColor('default'),
      text: 'No standup responses were collected today.'
    });
  } else {
    for (const [userId, data] of standupResponses.entries()) {
      if (data.status === 'answered') {
        // User header
        attachments.push({
          color: getColor('answered'),
          text: `✅ *Summary for @${data.username}*`
        });
        
        // Individual questions with their own colors
        data.answers.forEach((ans, i) => {
          attachments.push({
            color: getQuestionColor(i),
            title: QUESTIONS_ARRAY[i],
            text: ans
          });
        });
      } else if (data.status === 'skipped') {
        attachments.push({
          color: getColor('skipped'),
          text: `🟡 @${data.username}: Skipped the standup.`
        });
      } else if (data.status === 'pending') {
        attachments.push({
          color: getColor('pending'),
          text: `🔴 @${data.username}: Did not respond.`
        });
      }
    }
  }

  try {
    await api.post('chat.postMessage', {
      roomId: SUMMARY_CHANNEL_ID,
      text: `🗓️ *Daily Standup Consolidated Report*\n_Bot version: ${BOT_VERSION}_`,
      attachments: attachments
    });
    console.log('[publishStandupSummary] Final summary published successfully!');
  } catch (error) {
    console.error('[publishStandupSummary] Failed to publish summary:', error.message);
  }
};

/**
 * Generates the help message based on user permissions.
 * @param {boolean} isAdmin Whether the user is an admin.
 * @returns {string} The formatted help message.
 */
const getHelpMessage = (isAdmin) => {
  let helpMsg = `*Available Commands* 🤖\n\n`;
  helpMsg += `*User Commands:*\n`;
  helpMsg += `- \`ping\`: Check if I'm online.\n`;
  helpMsg += `- \`status\`: Check your membership and today's standup progress.\n`;
  helpMsg += `- \`start standup\`: Manually start or resume your standup.\n`;
  helpMsg += `- \`snooze [minutes]\`: Delay your standup reminder (default: 30m).\n`;
  helpMsg += `- \`show snooze\`: View remaining snooze time.\n`;
  helpMsg += `- \`vacation YYYY-MM-DD YYYY-MM-DD\`: Schedule a vacation period.\n`;  helpMsg += `- \`show vacation\`: View your scheduled vacation.\n`;
  helpMsg += `- \`clear vacation\`: Remove your vacation schedule.\n`;
  helpMsg += `- \`stats\`: View your participation statistics.\n`;
  helpMsg += `- \`help\`: Show this message.\n`;

  if (isAdmin) {
    helpMsg += `\n*Admin Commands:* 👑\n`;
    helpMsg += `- \`force summary\`: Immediately post the final summary for all users.\n`;
    helpMsg += `- \`list users\`: View all participants and their current status.\n`;
    helpMsg += `- \`list admins\`: View all users with administrative privileges.\n`;
    helpMsg += `- \`show schedule\`: View the current cron schedule for standups.\n`;
    helpMsg += `- \`set schedule [cron]\`: Dynamically update the standup schedule.\n`;
    helpMsg += `- \`team stats\`: View participation statistics for the entire team.\n`;
    helpMsg += `- \`add user @username\`: Add a user to the standup member list.\n`;
    helpMsg += `- \`remove user @username\`: Remove a user from the standup member list.\n`;
    helpMsg += `- \`add admin @username\`: Grant admin privileges to a user.\n`;
    helpMsg += `- \`remove admin @username\`: Revoke admin privileges from a user.\n`;
    helpMsg += `- \`mute YYYY-MM-DD [reason]\`: Mute standups for a specific date.\n`;
    helpMsg += `- \`unmute YYYY-MM-DD\`: Unmute standups for a specific date.\n`;
    helpMsg += `- \`list mutes\`: View all upcoming muted dates.\n`;
    helpMsg += `- \`delete standup @username\`: Delete today's entry for a user so they can redo it.\n`;    helpMsg += `- \`show standup @username YYYY-MM-DD\`: View a specific historical standup entry.\n`;
  }
  return helpMsg;
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

  // Handle Commands
  const cleanText = text.toLowerCase().trim();
  const isAdmin = ADMIN_USER_IDS.includes(userId);
  let commandMatched = false;

  // 1. Diagnostic / Help Commands
  if (cleanText === 'ping') {
    await sendDirectMessage({ _id: userId, username: username }, 'Pong! 🏓 I am alive and listening.');
    return;
  }

  if (cleanText === 'status') {
    const isMember = VALID_STANDUP_MEMBERS.some(m => m._id === userId);
    const session = standupResponses.get(userId);
    const dbEntry = await getStandupForToday(userId);

    let statusMsg = `*Bot Status Check*\n`;
    statusMsg += `- Bot Version: v${BOT_VERSION}\n`;
    statusMsg += `- Your Username: @${username}\n`;
    statusMsg += `- Your User ID: ${userId}\n`;
    statusMsg += `- Is Standup Member: ${isMember ? 'Yes ✅' : 'No ❌'}\n`;
    statusMsg += `- Is Admin: ${isAdmin ? 'Yes ⭐' : 'No'}\n`;
    statusMsg += `- Active Session: ${session ? `Yes (${session.status})` : 'None'}\n`;
    statusMsg += `- Today's DB Record: ${dbEntry ? `${dbEntry.status} ✅` : 'None ❌'}\n`;
    statusMsg += `- Bot Local Time: ${new Date().toString()}\n`;
    statusMsg += `- Configured Schedule: ${STANDUP_TIME}\n`;
    
    if (!isMember) {
      statusMsg += `\n_Note: You are not a registered standup member. Ask an admin to add you._`;
    }
    
    await sendDirectMessage({ _id: userId, username: username }, statusMsg);
    return;
  }

  if (cleanText === 'help') {
    await sendDirectMessage({ _id: userId, username: username }, getHelpMessage(isAdmin));
    return;
  }

  // 2. Vacation Commands
  if (cleanText.startsWith('vacation')) {
    commandMatched = true;
    const parts = text.split(' ').filter(p => p.trim() !== '');
    if (parts.length < 3) {
      await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `vacation YYYY-MM-DD YYYY-MM-DD` (Start and End date inclusive).');
      return;
    }

    const startStr = parts[1];
    const endStr = parts[2];
    const startDate = parseLocalDate(startStr);
    const endDate = parseLocalDate(endStr);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      await sendDirectMessage({ _id: userId, username: username }, '❌ Invalid date format. Please use YYYY-MM-DD.');
      return;
    }

    if (startDate > endDate) {
      await sendDirectMessage({ _id: userId, username: username }, '❌ Start date cannot be after end date.');
      return;
    }

    try {
      await Vacation.findOneAndUpdate(
        { userId: userId },
        { userId: userId, username: username, startDate: startDate, endDate: endDate },
        { upsert: true, new: true }
      );
      await sendDirectMessage({ _id: userId, username: username }, `Vacation set from ${startStr} to ${endStr}. I will automatically skip your standups during this period. ✅`);
    } catch (err) {
      console.error('[Vacation] Save failed:', err.message);
      await sendDirectMessage({ _id: userId, username: username }, `Error setting vacation: ${err.message}`);
    }
    return;
  }

  if (cleanText === 'show vacation') {
    commandMatched = true;
    try {
      const vacation = await Vacation.findOne({ userId: userId });
      if (vacation) {
        const startStr = formatLocalDate(vacation.startDate);
        const endStr = formatLocalDate(vacation.endDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isActive = today >= vacation.startDate && today <= vacation.endDate;
        await sendDirectMessage({ _id: userId, username: username }, `Your scheduled vacation: *${startStr}* to *${endStr}* ${isActive ? '(Currently Active 🌴)' : '(Upcoming/Past)'}\n\nTo clear it, type \`clear vacation\`.`);
      } else {
        await sendDirectMessage({ _id: userId, username: username }, 'You have no vacation periods scheduled.');
      }
    } catch (err) {
      console.error('[Vacation] Show failed:', err.message);
    }
    return;
  }

  if (cleanText === 'clear vacation') {
    commandMatched = true;
    try {
      await Vacation.deleteOne({ userId: userId });
      await sendDirectMessage({ _id: userId, username: username }, 'Your vacation period has been cleared. 🏠');
    } catch (err) {
      console.error('[Vacation] Clear failed:', err.message);
    }
    return;
  }

  if (cleanText === 'stats') {
    commandMatched = true;
    const isMember = VALID_STANDUP_MEMBERS.some(m => m._id === userId);
    if (!isMember) {
      await sendDirectMessage({ _id: userId, username: username }, "Statistics are only available for configured standup members.");
      return;
    }

    try {
      const stats = await Standup.aggregate([
        { $match: { userId: userId } },
        { $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ]);

      let total = 0;
      let answered = 0;
      let skipped = 0;
      let pending = 0;

      stats.forEach(s => {
        total += s.count;
        if (s._id === 'answered') answered = s.count;
        if (s._id === 'skipped') skipped = s.count;
        if (s._id === 'pending') pending = s.count;
      });

      const participationRate = total > 0 ? ((answered / total) * 100).toFixed(1) : 0;

      let msg = `📊 *Your Standup Statistics*\n\n`;
      msg += `- Total Prompts: ${total}\n`;
      msg += `- Completed: ${answered} ✅\n`;
      msg += `- Skipped: ${skipped} 🟡\n`;
      msg += `- Unanswered: ${pending} 🔴\n`;
      msg += `- Participation Rate: ${participationRate}%\n`;

      await sendDirectMessage({ _id: userId, username: username }, msg);
    } catch (err) {
      console.error('[Stats] Error:', err.message);
      await sendDirectMessage({ _id: userId, username: username }, "Failed to retrieve statistics.");
    }
    return;
  }

  // 3. Admin Commands
  if (isAdmin) {
    if (cleanText === 'force summary') {
      commandMatched = true;
      console.log(`[Admin] @${username} triggered manual summary.`);
      if (!SUMMARY_CHANNEL_ID) {
        SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);
      }
      await sendDirectMessage({ _id: userId, username: username }, 'Acknowledged. Publishing final standup summary now...');
      await publishStandupSummary();
      return;
    }

    if (cleanText === 'list users') {
      commandMatched = true;
      let listMsg = `*Active Standup Members (${VALID_STANDUP_MEMBERS.length}):*\n`;
      VALID_STANDUP_MEMBERS.forEach(m => {
        const session = standupResponses.get(m._id);
        listMsg += `- @${m.username} (ID: ${m._id}) [Session: ${session ? session.status : 'None'}]\n`;
      });
      await sendDirectMessage({ _id: userId, username: username }, listMsg);
      return;
    }

    if (cleanText === 'list admins') {
      commandMatched = true;
      try {
        const admins = await Member.find({ isAdmin: true });
        let listMsg = `*Bot Administrators (${admins.length}):*\n`;
        admins.forEach(a => {
          listMsg += `- @${a.username} (ID: ${a.userId})\n`;
        });
        await sendDirectMessage({ _id: userId, username: username }, listMsg);
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error listing admins: ${err.message}`);
      }
      return;
    }

    if (cleanText === 'team stats') {
      commandMatched = true;
      try {
        const globalStats = await Standup.aggregate([
          { $group: {
              _id: "$status",
              count: { $sum: 1 }
            }
          }
        ]);

        let total = 0;
        let answered = 0;
        let skipped = 0;
        let pending = 0;

        globalStats.forEach(s => {
          total += s.count;
          if (s._id === 'answered') answered = s.count;
          if (s._id === 'skipped') skipped = s.count;
          if (s._id === 'pending') pending = s.count;
        });

        const userLeaderboard = await Standup.aggregate([
          { $match: { status: 'answered' } },
          { $group: {
              _id: "$username",
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 5 }
        ]);

        let msg = `🏆 *Team Standup Statistics*\n\n`;
        msg += `*Overall Participation:*\n`;
        msg += `- Total Prompts: ${total}\n`;
        msg += `- Total Completed: ${answered} ✅\n`;
        msg += `- Total Skipped: ${skipped} 🟡\n`;
        msg += `- Total Unanswered: ${pending} 🔴\n\n`;
        
        if (userLeaderboard.length > 0) {
          msg += `*Top Participants (All-time):*\n`;
          userLeaderboard.forEach((u, i) => {
            msg += `${i+1}. @${u._id}: ${u.count} standups\n`;
          });
        }

        await sendDirectMessage({ _id: userId, username: username }, msg);
      } catch (err) {
        console.error('[Team Stats] Error:', err.message);
        await sendDirectMessage({ _id: userId, username: username }, "Failed to retrieve team statistics.");
      }
      return;
    }

    if (cleanText.startsWith('add user')) {
      commandMatched = true;
      const targetUsername = text.split(' ').slice(2).join(' ').replace(/^@/, '').trim();
      if (!targetUsername) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `add user @username`');
        return;
      }
      const targetId = await getUserIdByUsername(targetUsername);
      if (!targetId) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Could not find user @${targetUsername}`);
        return;
      }
      await Member.findOneAndUpdate(
        { userId: targetId },
        { userId: targetId, username: targetUsername, isStandupMember: true },
        { upsert: true }
      );
      await refreshMembers();
      await sendDirectMessage({ _id: userId, username: username }, `✅ Added @${targetUsername} to standup members.`);
      return;
    }

    if (cleanText.startsWith('remove user')) {
      commandMatched = true;
      const targetUsername = text.split(' ').slice(2).join(' ').replace(/^@/, '').trim();
      if (!targetUsername) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `remove user @username`');
        return;
      }
      const targetId = await getUserIdByUsername(targetUsername);
      if (!targetId) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Could not find user @${targetUsername}`);
        return;
      }
      await Member.findOneAndUpdate(
        { userId: targetId },
        { isStandupMember: false }
      );
      await refreshMembers();
      await sendDirectMessage({ _id: userId, username: username }, `✅ Removed @${targetUsername} from standup members.`);
      return;
    }

    if (cleanText.startsWith('add admin')) {
      commandMatched = true;
      const targetUsername = text.split(' ').slice(2).join(' ').replace(/^@/, '').trim();
      if (!targetUsername) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `add admin @username`');
        return;
      }
      const targetId = await getUserIdByUsername(targetUsername);
      if (!targetId) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Could not find user @${targetUsername}`);
        return;
      }
      await Member.findOneAndUpdate(
        { userId: targetId },
        { userId: targetId, username: targetUsername, isAdmin: true },
        { upsert: true }
      );
      await refreshMembers();
      await sendDirectMessage({ _id: userId, username: username }, `✅ Added @${targetUsername} to admins.`);
      return;
    }

    if (cleanText.startsWith('remove admin')) {
      commandMatched = true;
      const targetUsername = text.split(' ').slice(2).join(' ').replace(/^@/, '').trim();
      if (!targetUsername) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `remove admin @username`');
        return;
      }
      const targetId = await getUserIdByUsername(targetUsername);
      if (!targetId) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Could not find user @${targetUsername}`);
        return;
      }
      await Member.findOneAndUpdate(
        { userId: targetId },
        { isAdmin: false }
      );
      await refreshMembers();
      await sendDirectMessage({ _id: userId, username: username }, `✅ Removed @${targetUsername} from admins.`);
      return;
    }

    if (cleanText.startsWith('mute')) {
      commandMatched = true;
      const parts = text.split(' ').filter(p => p.trim() !== '');
      if (parts.length < 2) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `mute YYYY-MM-DD [reason]`');
        return;
      }

      const dateStr = parts[1];
      const muteDate = parseLocalDate(dateStr);
      const reason = parts.slice(2).join(' ') || 'Holiday/Day Off';

      if (isNaN(muteDate.getTime())) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Invalid date format: "${dateStr}". Please use YYYY-MM-DD.`);
        return;
      }

      try {
        await Mute.findOneAndUpdate(
          { date: muteDate },
          { date: muteDate, reason: reason, addedBy: username },
          { upsert: true }
        );
        await sendDirectMessage({ _id: userId, username: username }, `✅ Standup muted for **${dateStr}** (${reason}).`);
        
        // Notify summary channel
        if (!SUMMARY_CHANNEL_ID) {
          SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);
        }
        await api.post('chat.postMessage', {
          roomId: SUMMARY_CHANNEL_ID,
          text: `🔕 *Standup Muted for ${dateStr}*\nReason: ${reason}\n_Admin: @${username}_`
        });
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error muting date: ${err.message}`);
      }
      return;
    }

    if (cleanText.startsWith('unmute')) {
      commandMatched = true;
      const parts = text.split(' ').filter(p => p.trim() !== '');
      if (parts.length < 2) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `unmute YYYY-MM-DD`');
        return;
      }

      const dateStr = parts[1];
      const muteDate = parseLocalDate(dateStr);
      if (isNaN(muteDate.getTime())) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Invalid date format: "${dateStr}". Please use YYYY-MM-DD.`);
        return;
      }

      try {
        const result = await Mute.deleteOne({ date: muteDate });
        if (result.deletedCount > 0) {
          await sendDirectMessage({ _id: userId, username: username }, `✅ Standup unmuted for **${dateStr}**.`);
          
          // Notify summary channel
          if (!SUMMARY_CHANNEL_ID) {
            SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);
          }
          await api.post('chat.postMessage', {
            roomId: SUMMARY_CHANNEL_ID,
            text: `🔔 *Standup Unmuted for ${dateStr}*\n_Standups will proceed as scheduled._\n_Admin: @${username}_`
          });
        } else {
          await sendDirectMessage({ _id: userId, username: username }, `No mute found for **${dateStr}**.`);
        }
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error unmuting date: ${err.message}`);
      }
      return;
    }

    if (cleanText === 'list mutes') {
      commandMatched = true;
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const mutes = await Mute.find({ date: { $gte: today } }).sort({ date: 1 });
        
        if (mutes.length === 0) {
          await sendDirectMessage({ _id: userId, username: username }, 'No upcoming muted dates.');
          return;
        }

        let listMsg = `*Upcoming Muted Dates (${mutes.length}):*\n`;
        mutes.forEach(m => {
          const dStr = formatLocalDate(m.date);
          listMsg += `- **${dStr}**: ${m.reason} (Added by @${m.addedBy})\n`;
        });
        await sendDirectMessage({ _id: userId, username: username }, listMsg);
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error listing mutes: ${err.message}`);
      }
      return;
    }

    if (cleanText.startsWith('delete standup')) {
      commandMatched = true;
      const parts = text.split(' ').filter(p => p.trim() !== '');
      if (parts.length < 3) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `delete standup @username`');
        return;
      }
      
      const targetUsername = parts[2].replace(/^@/, '');
      
      try {
        const targetUserId = await getUserIdByUsername(targetUsername);
        if (!targetUserId) {
          await sendDirectMessage({ _id: userId, username: username }, `Could not find user @${targetUsername}`);
          return;
        }

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const deleteResult = await Standup.deleteOne({
          userId: targetUserId,
          date: { $gte: startOfDay, $lte: endOfDay }
        });

        standupResponses.delete(targetUserId);
        lastSentQuestionIndex.delete(targetUserId);

        if (deleteResult.deletedCount > 0) {
          await sendDirectMessage({ _id: userId, username: username }, `Successfully deleted today's standup for @${targetUsername}. They can now start over.`);
        } else {
          await sendDirectMessage({ _id: userId, username: username }, `No standup found for @${targetUsername} today.`);
        }
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error deleting standup: ${err.message}`);
      }
      return;
    }

    if (cleanText.startsWith('show standup')) {
      commandMatched = true;
      const parts = text.split(' ').filter(p => p.trim() !== '');
      if (parts.length < 4) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `show standup @username YYYY-MM-DD`');
        return;
      }

      const targetUsername = parts[2].replace(/^@/, '');
      const dateStr = parts[3];
      const targetDate = parseLocalDate(dateStr);

      if (isNaN(targetDate.getTime())) {
        await sendDirectMessage({ _id: userId, username: username }, `❌ Invalid date format: "${dateStr}". Please use YYYY-MM-DD.`);
        return;
      }

      try {
        const targetUserId = await getUserIdByUsername(targetUsername);
        if (!targetUserId) {
          await sendDirectMessage({ _id: userId, username: username }, `Could not find user @${targetUsername}`);
          return;
        }

        const startOfTargetDay = new Date(targetDate);
        startOfTargetDay.setHours(0, 0, 0, 0);
        const endOfTargetDay = new Date(targetDate);
        endOfTargetDay.setHours(23, 59, 59, 999);

        const record = await Standup.findOne({
          userId: targetUserId,
          date: { $gte: startOfTargetDay, $lte: endOfTargetDay }
        });

        if (!record) {
          await sendDirectMessage({ _id: userId, username: username }, `No standup record found for @${targetUsername} on ${dateStr}.`);
          return;
        }

        const attachments = [];
        attachments.push({ color: getColor(record.status), text: `📜 *Historical Standup for @${record.username} (${dateStr})*` });
        record.answers.forEach((ans, i) => {
          attachments.push({ color: getQuestionColor(i), title: ans.question || QUESTIONS_ARRAY[i] || `Question ${i + 1}`, text: ans.answer });
        });

        await api.post('chat.postMessage', {
          roomId: (await api.post('im.create', { username: username })).room._id,
          attachments: attachments
        });
      } catch (err) {
        await sendDirectMessage({ _id: userId, username: username }, `Error retrieving history: ${err.message}`);
      }
      return;
    }

    if (cleanText === 'show schedule') {
      commandMatched = true;
      await sendDirectMessage({ _id: userId, username: username }, `The current standup schedule is set to: \`${currentStandupTime}\``);
      return;
    }

    if (cleanText.startsWith('set schedule')) {
      commandMatched = true;
      const pattern = text.replace(/set schedule/i, '').trim();
      
      if (!pattern) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Usage: `set schedule [cron pattern]` (e.g., `set schedule 0 10 * * 1-5`)');
        return;
      }

      if (!cron.validate(pattern.replace('1-7', '*'))) {
        await sendDirectMessage({ _id: userId, username: username }, '❌ Invalid cron pattern. Please check your syntax.');
        return;
      }

      try {
        // Save to Config collection for persistence
        await Config.findOneAndUpdate(
          { key: 'standupTime' },
          { value: pattern },
          { upsert: true, new: true }
        );

        // Apply the new schedule
        scheduleStandup(pattern);

        await sendDirectMessage({ _id: userId, username: username }, `✅ Standup schedule updated successfully to: \`${pattern}\``);
      } catch (err) {
        console.error('[Admin] Set schedule failed:', err.message);
        await sendDirectMessage({ _id: userId, username: username }, `Error saving schedule: ${err.message}`);
      }
      return;
    }
  }

  // 4. Standup Flow Logic
  let userSession = standupResponses.get(userId);

  if (cleanText.startsWith('snooze')) {
    if (!userSession || userSession.status !== 'pending') {
      await sendDirectMessage({ _id: userId, username: username }, "You don't have an active standup to snooze.");
      return;
    }

    const parts = text.split(' ').filter(p => p.trim() !== '');
    let snoozeMinutes = 30; // Default
    if (parts.length >= 2) {
      const val = parseInt(parts[1], 10);
      if (!isNaN(val) && val > 0) {
        snoozeMinutes = val;
      }
    }

    const snoozeUntil = new Date();
    snoozeUntil.setMinutes(snoozeUntil.getMinutes() + snoozeMinutes);

    try {
      await Standup.findByIdAndUpdate(userSession.dbId, { snoozeUntil: snoozeUntil });
      
      // Clear from memory so the cron will pick it up later
      standupResponses.delete(userId);
      lastSentQuestionIndex.delete(userId);

      await sendDirectMessage({ _id: userId, username: username }, `Standup snoozed 😴. I will remind you again in ${snoozeMinutes} minutes.`);
      console.log(`[Snooze] @${username} snoozed until ${snoozeUntil.toISOString()}`);
    } catch (err) {
      console.error('[Snooze] Error:', err.message);
    }
    return;
  }

  if (cleanText === 'show snooze') {
    commandMatched = true;
    try {
      const record = await getStandupForToday(userId);
      const now = new Date();
      if (record && record.snoozeUntil && record.snoozeUntil > now) {
        const diffMs = record.snoozeUntil - now;
        const diffMins = Math.ceil(diffMs / (1000 * 60));
        
        await sendDirectMessage({ _id: userId, username: username }, `You have **${diffMins} minutes** of snooze remaining. I will remind you at ${record.snoozeUntil.toLocaleTimeString()}. 😴`);
      } else {
        await sendDirectMessage({ _id: userId, username: username }, "You don't have an active snooze.");
      }
    } catch (err) {
      console.error('[Snooze] Show failed:', err.message);
    }
    return;
  }

  if (cleanText === 'start standup') {
    const member = VALID_STANDUP_MEMBERS.find(m => m._id === userId);
    if (!member) {
      await sendDirectMessage({ _id: userId, username: username }, 'Sorry, you are not configured to participate in the standup.');
      return;
    }

    const onVacation = await isUserOnVacation(userId);
    if (onVacation) {
      await sendDirectMessage({ _id: userId, username: username }, 'You are currently marked as on vacation 🌴. If you want to participate, please use `clear vacation` first.');
      return;
    }

    const existingStandup = await getStandupForToday(userId);
    if (existingStandup) {
      if (existingStandup.status === 'answered' || existingStandup.status === 'skipped') {
        await sendDirectMessage({ _id: userId, username: username }, `You have already ${existingStandup.status} today's standup.`);
        return;
      }
      
      if (existingStandup.status === 'pending' && !userSession) {
        userSession = { username: username, answers: existingStandup.answers.map(a => a.answer), status: 'pending', dbId: existingStandup._id };
        standupResponses.set(userId, userSession);
      }
    }

    if (!userSession) {
      userSession = { username: username, answers: [], status: 'pending' };
      standupResponses.set(userId, userSession);
      const standup = new Standup({ userId: userId, username: username, status: 'pending', answers: [] });
      await standup.save();
      userSession.dbId = standup._id;
    }

    await askNextQuestion(userId, userSession);
    return;
  }

  // 5. Active Session Handling
  if (userSession && (userSession.status === 'pending')) {
    if (userSession.isProcessing) return;
    userSession.isProcessing = true;

    try {
      if (cleanText === 'skip') {
        userSession.status = 'skipped';
        await Standup.findByIdAndUpdate(userSession.dbId, { status: 'skipped' }).catch(e => console.error('DB Skip update failed:', e.message));
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
        await Standup.findByIdAndUpdate(userSession.dbId, {
          $push: { answers: { question: currentQuestion, answer: text } },
          status: isFinished ? 'answered' : 'pending'
        }).catch(dbError => console.error('Error saving to MongoDB:', dbError.message));
        if (isFinished) userSession.status = 'answered';
        await askNextQuestion(userId, userSession);
      }
    } catch (error) {
      console.error('Error in processStandupResponse flow:', error.message);
    } finally {
      userSession.isProcessing = false;
    }
    return;
  }

  // 6. Fallback: If no command matched and no session is active, show help
  if (!commandMatched) {
    await sendDirectMessage({ _id: userId, username: username }, "I didn't recognize that command.\n\n" + getHelpMessage(isAdmin));
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

    // 2. Load existing sessions for today from DB
    await loadTodaySessions();
    
    // 3. Load or initialize the standup schedule
    const savedTime = await Config.findOne({ key: 'standupTime' });
    if (savedTime) {
      console.log(`[start] Found saved standup schedule in DB: "${savedTime.value}"`);
      currentStandupTime = savedTime.value;
    } else {
      console.log(`[start] No saved schedule in DB, using default: "${currentStandupTime}"`);
    }

    scheduleStandup(currentStandupTime);

    // Add a heartbeat log every minute to verify the clock and scheduler
    cron.schedule('0 * * * * *', () => {
      console.log(`[Heartbeat] Bot time: ${new Date().toLocaleTimeString()} | Users: ${VALID_STANDUP_MEMBERS.length}`);
      checkSnoozes(); // Also check for snoozes every minute
    });

    console.log(`\n✅ Standup bot is fully ready!`);
    console.log(`- Bot Version: v${BOT_VERSION}`);
    console.log(`- Bot Time: ${new Date().toString()}`);
    console.log(`- Scheduled: ${currentStandupTime}`);
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
  loadTodaySessions,
  publishIndividualSummary,
  promptUsersForStandup,
  processStandupResponse,
  standupResponses,
  Standup,
  Vacation,
  Config,
  Member,
  Mute,
  refreshMembers,
  scheduleStandup,
  checkSnoozes,
  isUserOnVacation,
  VALID_STANDUP_MEMBERS,
  ADMIN_USER_IDS
};
