const { 
  getStandupForToday, 
  processStandupResponse, 
  standupResponses, 
  Standup, 
  VALID_STANDUP_MEMBERS 
} = require('../src/index');

// Mock Mongoose
jest.mock('mongoose', () => {
  const m = {
    connect: jest.fn(),
    Schema: jest.fn().mockImplementation(() => ({ index: jest.fn() })),
    model: jest.fn().mockReturnValue({
      findOne: jest.fn(),
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
    sendToRoomId: jest.fn()
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

      const { driver } = require('@rocket.chat/sdk');
      const { api } = require('@rocket.chat/sdk');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Pong!'),
        expect.any(String)
      );
    });
  });
});
