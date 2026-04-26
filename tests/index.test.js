// Set environment variables for tests
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.STANDUP_USERS = 'member1,member2';
process.env.QUESTIONS = 'Q1;Q2';

const { 
  getStandupForToday, 
  loadTodaySessions,
  processStandupResponse, 
  standupResponses, 
  Standup, 
  VALID_STANDUP_MEMBERS,
  ADMIN_USER_IDS
} = require('../src/index');

// Mock Mongoose
jest.mock('mongoose', () => {
  const m = {
    connect: jest.fn(),
    Schema: jest.fn().mockImplementation(() => ({ index: jest.fn() })),
    model: jest.fn().mockReturnValue({
      findOne: jest.fn(),
      find: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      prototype: { save: jest.fn() }
    }),
    findByIdAndUpdate: jest.fn()
  };
  return m;
});

// Mock Rocket.Chat SDK
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
    post: jest.fn()
  }
}));

describe('Standup Bot Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    standupResponses.clear();
    VALID_STANDUP_MEMBERS.length = 0;
    ADMIN_USER_IDS.length = 0;
  });

  describe('getStandupForToday', () => {
    it('should query MongoDB with correct date boundaries', async () => {
      const mockUserId = 'user123';
      const findOneSpy = jest.spyOn(Standup, 'findOne').mockResolvedValue(null);

      await getStandupForToday(mockUserId);

      expect(findOneSpy).toHaveBeenCalledWith(expect.objectContaining({
        userId: mockUserId,
        date: expect.objectContaining({
          $gte: expect.any(Date),
          $lte: expect.any(Date)
        })
      }));
    });
  });

  describe('loadTodaySessions', () => {
    it('should restore today\'s sessions from MongoDB into memory', async () => {
      const mockRecords = [
        {
          userId: 'user1',
          username: 'user1',
          status: 'answered',
          answers: [{ question: 'Q1', answer: 'A1' }],
          _id: 'dbid1'
        },
        {
          userId: 'user2',
          username: 'user2',
          status: 'pending',
          answers: [],
          _id: 'dbid2'
        }
      ];

      jest.spyOn(Standup, 'find').mockResolvedValue(mockRecords);

      await loadTodaySessions();

      expect(standupResponses.size).toBe(2);
      expect(standupResponses.get('user1')).toMatchObject({
        username: 'user1',
        status: 'answered',
        answers: ['A1']
      });
      expect(standupResponses.get('user2')).toMatchObject({
        username: 'user2',
        status: 'pending',
        answers: []
      });
    });
  });

  describe('Manual Trigger: start standup', () => {
    it('should reject standup if user is not in the valid members list', async () => {
      const mockMessage = {
        u: { _id: 'unknown', username: 'unknown' },
        msg: 'start standup',
        _id: 'msg1'
      };

      // Mock SDK methods that would be called
      const { api } = require('@rocket.chat/sdk');
      const { driver } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      // Should send an error message
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('not configured to participate'),
        expect.any(String)
      );
    });

    it('should reject standup if user already completed it today (DB check)', async () => {
      const mockUserId = 'member1';
      VALID_STANDUP_MEMBERS.push({ _id: mockUserId, username: 'member1' });
      
      const mockMessage = {
        u: { _id: mockUserId, username: 'member1' },
        msg: 'start standup',
        _id: 'msg2'
      };

      // Mock DB to return an already answered standup
      jest.spyOn(Standup, 'findOne').mockResolvedValue({
        status: 'answered',
        userId: mockUserId
      });

      const { driver } = require('@rocket.chat/sdk');
      const { api } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      // Verify rejection message
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('already answered today'),
        expect.any(String)
      );
    });
  });

  describe('Diagnostic Commands', () => {
    it('should respond to ping', async () => {
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'ping',
        _id: 'msg3'
      };

      const { driver, api } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Pong!'),
        expect.any(String)
      );
    });

    it('should show user help to regular users', async () => {
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'help',
        _id: 'msg_help_user'
      };

      const { driver, api } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('User Commands'),
        'room1'
      );
      expect(driver.sendToRoomId).not.toHaveBeenCalledWith(
        expect.stringContaining('Admin Commands'),
        expect.any(String)
      );
    });

    it('should show admin help to admin users', async () => {
      ADMIN_USER_IDS.push('admin1');
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'help',
        _id: 'msg_help_admin'
      };

      const { driver, api } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Admin Commands'),
        'room1'
      );
    });
  });

  describe('Admin Commands', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    beforeEach(() => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      driver.getRoomId.mockResolvedValue('summary_room_id');
    });

    it('should allow admin to trigger force summary', async () => {
      // Setup an answered user to verify content
      standupResponses.set('user1', {
        username: 'user1',
        status: 'answered',
        answers: ['Work 1', 'Work 2']
      });

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'force summary',
        _id: 'msg_admin1'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Work 1'),
        'summary_room_id'
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Publishing final standup summary now'),
        expect.any(String)
      );
    });

    it('should allow admin to list users', async () => {
      VALID_STANDUP_MEMBERS.push({ _id: 'user1', username: 'user1' });
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'list users',
        _id: 'msg_admin2'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Active Standup Members (1)'),
        expect.any(String)
      );
    });

    it('should reject admin commands from non-admins', async () => {
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'force summary',
        _id: 'msg_nonadmin'
      };

      await processStandupResponse(mockMessage);

      // Should not trigger the admin response
      expect(driver.sendToRoomId).not.toHaveBeenCalledWith(
        expect.stringContaining('Publishing final standup summary now'),
        expect.any(String)
      );
    });
  });
});
