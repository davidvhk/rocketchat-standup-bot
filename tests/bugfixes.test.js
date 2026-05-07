
// Set environment variables for tests
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.STANDUP_USERS = 'member1,member2';
process.env.QUESTIONS = 'Q1;Q2';
process.env.ROCKETCHAT_URL = 'https://chat.vhkzone.org';
// Mock node-cron
jest.mock('node-cron', () => ({
  schedule: jest.fn().mockReturnValue({
    stop: jest.fn(),
    start: jest.fn()
  }),
  validate: jest.fn().mockReturnValue(true)
}));

// Mock axios and form-data
const mockAxios = {
  post: jest.fn().mockResolvedValue({ data: { success: true } }),
  create: jest.fn().mockReturnThis()
};
jest.mock('axios', () => mockAxios);

jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    getHeaders: jest.fn().mockReturnValue({ 'content-type': 'multipart/form-data' })
  }));
});

// Mock Rocket.Chat SDK BEFORE requiring the module
jest.mock('@rocket.chat/sdk', () => ({
  driver: {
    connect: jest.fn(),
    login: jest.fn(),
    subscribeToMessages: jest.fn(),
    reactToMessages: jest.fn(),
    sendToRoomId: jest.fn(),
    getRoomId: jest.fn()
  },
  api: {
    login: jest.fn(),
    get: jest.fn(),
    post: jest.fn(),
    currentLogin: { authToken: 'token', userId: 'botid' }
  }
}));

// Mock Mongoose
jest.mock('mongoose', () => {
  const m = {
    connect: jest.fn(),
    Schema: jest.fn().mockImplementation(() => ({ index: jest.fn() })),
    model: jest.fn().mockImplementation(() => {
      const MockModel = jest.fn().mockImplementation(() => ({
        save: jest.fn().mockResolvedValue({ _id: 'mock_id' })
      }));
      MockModel.findOne = jest.fn().mockResolvedValue(null);
      MockModel.find = jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue([])
      });
      MockModel.deleteOne = jest.fn().mockResolvedValue({ deletedCount: 0 });
      MockModel.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
      MockModel.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      MockModel.findOneAndUpdate = jest.fn().mockResolvedValue({});
      MockModel.aggregate = jest.fn().mockResolvedValue([]);
      MockModel.countDocuments = jest.fn().mockResolvedValue(1);
      MockModel.index = jest.fn();
      return MockModel;
    }),
    findByIdAndUpdate: jest.fn()
  };
  m.Schema.Types = { Mixed: 'Mixed' };
  return m;
});

const { 
  processStandupResponse, 
  standupResponses, 
  Standup, 
  Member,
  VALID_STANDUP_MEMBERS,
  lastSentQuestionIndex
} = require('../src/index');

describe('Bug Fixes Verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    standupResponses.clear();
    lastSentQuestionIndex.clear();
    VALID_STANDUP_MEMBERS.length = 0;
  });

  it('should not skip the first question even if it was sent in a previous session (Fix: lastSentQuestionIndex clear)', async () => {
    const { driver, api } = require('@rocket.chat/sdk');
    const mockUserId = 'user1';
    const mockUsername = 'user1';
    
    VALID_STANDUP_MEMBERS.push({ _id: mockUserId, username: mockUsername });
    api.post.mockResolvedValue({ room: { _id: 'room1' }, success: true });

    // Simulate yesterday: User was asked Q1 (index 0) but didn't finish.
    const msgStart = {
      u: { _id: mockUserId, username: mockUsername },
      msg: 'start standup',
      _id: 'msg1'
    };

    await processStandupResponse(msgStart);
    
    // Q1 should have been sent
    expect(driver.sendToRoomId).toHaveBeenCalledWith(expect.stringContaining('Q1'), expect.any(String));
    
    // Now simulate a "new day" by clearing standupResponses but NOT restarting the process
    standupResponses.clear();
    driver.sendToRoomId.mockClear();

    // User tries to start standup again today
    const msgStartToday = {
      u: { _id: mockUserId, username: mockUsername },
      msg: 'start standup',
      _id: 'msg2'
    };

    await processStandupResponse(msgStartToday);

    // FIX: Q1 should be sent again now because we clear the tracker on manual start
    const q1Call = driver.sendToRoomId.mock.calls.find(call => call[0].includes('Q1'));
    expect(q1Call).toBeDefined();
  });

  it('should update the username in VALID_STANDUP_MEMBERS and database when a message is received with a new username (Fix: Username Confusion)', async () => {
    const { driver, api } = require('@rocket.chat/sdk');
    const mockUserId = 'user123';
    const oldUsername = 'old_bob';
    const newUsername = 'new_robert';

    // Mock initial state
    VALID_STANDUP_MEMBERS.push({ _id: mockUserId, username: oldUsername });
    const findOneAndUpdateSpy = jest.spyOn(Member, 'findOneAndUpdate').mockResolvedValue({});
    api.post.mockResolvedValue({ room: { _id: 'room1' }, success: true });

    const mockMessage = {
      u: { _id: mockUserId, username: newUsername },
      msg: 'ping',
      _id: 'msg_ping'
    };

    await processStandupResponse(mockMessage);

    // Verify memory update
    expect(VALID_STANDUP_MEMBERS[0].username).toBe(newUsername);
    // Verify DB update
    expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
      { userId: mockUserId },
      { username: newUsername }
    );
  });
});
