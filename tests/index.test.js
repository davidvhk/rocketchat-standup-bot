// Set environment variables for tests
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.STANDUP_USERS = 'member1,member2';
process.env.QUESTIONS = 'Q1;Q2';
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

const { 
  getStandupForToday, 
  loadTodaySessions,
  publishIndividualSummary,
  processStandupResponse, 
  standupResponses, 
  Standup, 
  Holiday,
  Config,
  Member,
  Mute,
  refreshMembers,
  scheduleStandup,
  checkSnoozes,
  isUserOnHoliday,
  generateCSV,
  uploadFile,
  VALID_STANDUP_MEMBERS,
  ADMIN_USER_IDS
} = require('../src/index');

// Mock Mongoose
jest.mock('mongoose', () => {
  const m = {
    connect: jest.fn(),
    Schema: jest.fn().mockImplementation(() => ({ index: jest.fn() })),
    model: jest.fn().mockImplementation(() => ({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue([])
      }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue([]),
      prototype: { save: jest.fn().mockResolvedValue({}) }
    })),
    findByIdAndUpdate: jest.fn()
  };
  m.Schema.Types = { Mixed: 'Mixed' };
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

  describe('publishIndividualSummary', () => {
    it('should post multiple colored attachments for a user summary', async () => {
      const { api } = require('@rocket.chat/sdk');
      const userResponse = {
        username: 'user1',
        status: 'answered',
        answers: ['Answer 1', 'Answer 2']
      };

      await publishIndividualSummary('user1', userResponse);

      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('Summary for @user1') }),
            expect.objectContaining({ color: '#2de0a5', title: 'Q1', text: 'Answer 1' }),
            expect.objectContaining({ color: '#1d74f5', title: 'Q2', text: 'Answer 2' })
          ])
        })
      );
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

      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('Summary for @user1') }),
            expect.objectContaining({ color: '#2de0a5', title: 'Q1', text: 'Work 1' }),
            expect.objectContaining({ color: '#1d74f5', title: 'Q2', text: 'Work 2' })
          ])
        })
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

    it('should allow admin to list admins', async () => {
      jest.spyOn(Member, 'find').mockResolvedValue([
        { userId: 'admin1', username: 'admin1', isAdmin: true }
      ]);
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'list admins',
        _id: 'msg_list_admins'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Bot Administrators (1)'),
        expect.any(String)
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('@admin1'),
        expect.any(String)
      );
    });

    it('should allow admin to delete a user standup', async () => {
      const { driver, api } = require('@rocket.chat/sdk');
      // Mock user lookup
      api.get.mockResolvedValue({ user: { _id: 'user1', username: 'user1' } });
      // Mock deletion
      jest.spyOn(Standup, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
      
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'delete standup @user1',
        _id: 'msg_delete'
      };

      await processStandupResponse(mockMessage);

      expect(Standup.deleteOne).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user1'
      }));
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Successfully deleted today\'s standup for @user1'),
        expect.any(String)
      );
    });

    it('should allow admin to show historical standup', async () => {
      const { driver, api } = require('@rocket.chat/sdk');
      // Mock user lookup
      api.get.mockResolvedValue({ user: { _id: 'user1', username: 'user1' } });
      // Mock historical record
      const mockRecord = {
        userId: 'user1',
        username: 'user1',
        status: 'answered',
        answers: [{ question: 'Q1', answer: 'Old Answer' }],
        _id: 'old_dbid'
      };
      jest.spyOn(Standup, 'findOne').mockResolvedValue(mockRecord);
      // Mock DM room creation for the admin
      api.post.mockResolvedValue({ room: { _id: 'admin_dm_room' } });
      
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'show standup @user1 2026-04-20',
        _id: 'msg_show'
      };

      await processStandupResponse(mockMessage);

      expect(Standup.findOne).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user1',
        date: expect.any(Object)
      }));
      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('Historical Standup for @user1') }),
            expect.objectContaining({ text: 'Old Answer' })
          ])
        })
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

  describe('Holiday Logic', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    it('should allow user to set holiday', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      const findOneAndUpdateSpy = jest.spyOn(Holiday, 'findOneAndUpdate').mockResolvedValue({});
      
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'holiday 2026-05-01 2026-05-10',
        _id: 'msg_holiday'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user1' }),
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date)
        }),
        expect.any(Object)
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Holiday set from 2026-05-01 to 2026-05-10'),
        expect.any(String)
      );
    });

    it('should show current holiday', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      jest.spyOn(Holiday, 'find').mockReturnValue({
        sort: jest.fn().mockResolvedValue([{
          userId: 'user1',
          startDate: new Date(2026, 4, 1),
          endDate: new Date(2026, 4, 10)
        }])
      });
      
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'show holiday',
        _id: 'msg_show_holiday'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('*2026-05-01* to *2026-05-10*'),
        expect.any(String)
      );
    });

    it('should allow user to clear all holidays', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      jest.spyOn(Holiday, 'deleteMany').mockResolvedValue({ deletedCount: 1 });
      
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'clear holiday all',
        _id: 'msg_clear_hol_all'
      };

      await processStandupResponse(mockMessage);

      expect(Holiday.deleteMany).toHaveBeenCalledWith({ userId: 'user1' });
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('All your holiday periods (1) have been cleared'),
        expect.any(String)
      );
    });

    it('should allow user to clear a specific holiday', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      const mockHoliday = {
        _id: 'hol_id_1',
        userId: 'user1',
        startDate: new Date(2026, 4, 1),
        endDate: new Date(2026, 4, 10)
      };
      jest.spyOn(Holiday, 'find').mockReturnValue({
        sort: jest.fn().mockResolvedValue([mockHoliday])
      });
      jest.spyOn(Holiday, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
      
      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'clear holiday 1',
        _id: 'msg_clear_hol_1'
      };

      await processStandupResponse(mockMessage);

      expect(Holiday.deleteOne).toHaveBeenCalledWith({ _id: 'hol_id_1' });
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Holiday period #1 (2026-05-01 to 2026-05-10) has been cleared'),
        expect.any(String)
      );
    });

    it('should reject starting standup if on holiday', async () => {
      VALID_STANDUP_MEMBERS.push({ _id: 'user1', username: 'user1' });
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      
      // Mock being on holiday
      jest.spyOn(Holiday, 'findOne').mockResolvedValue({
        userId: 'user1',
        startDate: new Date(2026, 0, 1),
        endDate: new Date(2026, 11, 31)
      });

      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'start standup',
        _id: 'msg_start_holiday'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('currently marked as on holiday'),
        expect.any(String)
      );
    });
  });

  describe('Statistics Commands', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    it('should show personal stats to a member', async () => {
      VALID_STANDUP_MEMBERS.push({ _id: 'user1', username: 'user1' });
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      
      const aggregateSpy = jest.spyOn(Standup, 'aggregate').mockResolvedValue([
        { _id: 'answered', count: 10 },
        { _id: 'skipped', count: 2 }
      ]);

      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'stats',
        _id: 'msg_stats'
      };

      await processStandupResponse(mockMessage);

      expect(aggregateSpy).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ $match: { userId: 'user1' } })
      ]));
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Completed: 10'),
        expect.any(String)
      );
    });

    it('should allow admin to see team stats', async () => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      
      // Mock global stats and then leaderboard
      const aggregateSpy = jest.spyOn(Standup, 'aggregate')
        .mockResolvedValueOnce([{ _id: 'answered', count: 50 }]) // global
        .mockResolvedValueOnce([{ _id: 'user1', count: 20 }, { _id: 'user2', count: 15 }]); // leaderboard

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'team stats',
        _id: 'msg_team_stats'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Team Standup Statistics'),
        expect.any(String)
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('@user1: 20 standups'),
        expect.any(String)
      );
    });
  });

  describe('Schedule Management', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    it('should allow admin to show schedule', async () => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'show schedule',
        _id: 'msg_show_sched'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('current standup schedule is set to'),
        expect.any(String)
      );
    });

    it('should allow admin to set schedule', async () => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      const findOneAndUpdateSpy = jest.spyOn(Config, 'findOneAndUpdate').mockResolvedValue({});
      
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'set schedule 0 12 * * 1-5',
        _id: 'msg_set_sched'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { key: 'standupTime' },
        { value: '0 12 * * 1-5' },
        { upsert: true, new: true }
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('schedule updated successfully'),
        expect.any(String)
      );
    });
  });

  describe('Member Management', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    beforeEach(() => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
    });

    it('should allow admin to add a standup member', async () => {
      api.get.mockResolvedValue({ user: { _id: 'newuser_id', username: 'newuser' } });
      const findOneAndUpdateSpy = jest.spyOn(Member, 'findOneAndUpdate').mockResolvedValue({});
      jest.spyOn(Member, 'find').mockResolvedValue([
        { userId: 'newuser_id', username: 'newuser', isStandupMember: true, isAdmin: false }
      ]);

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'add user @newuser',
        _id: 'msg_add_user'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { userId: 'newuser_id' },
        expect.objectContaining({ isStandupMember: true }),
        { upsert: true }
      );
      expect(VALID_STANDUP_MEMBERS).toContainEqual({ _id: 'newuser_id', username: 'newuser' });
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Added @newuser to standup members'),
        expect.any(String)
      );
    });

    it('should allow admin to remove a standup member', async () => {
      api.get.mockResolvedValue({ user: { _id: 'user1_id', username: 'user1' } });
      const findOneAndUpdateSpy = jest.spyOn(Member, 'findOneAndUpdate').mockResolvedValue({});
      jest.spyOn(Member, 'find').mockResolvedValue([]); // Empty after removal

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'remove user @user1',
        _id: 'msg_remove_user'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { userId: 'user1_id' },
        { isStandupMember: false }
      );
      expect(VALID_STANDUP_MEMBERS.length).toBe(0);
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Removed @user1 from standup members'),
        expect.any(String)
      );
    });

    it('should allow admin to add an admin', async () => {
      api.get.mockResolvedValue({ user: { _id: 'newadmin_id', username: 'newadmin' } });
      const findOneAndUpdateSpy = jest.spyOn(Member, 'findOneAndUpdate').mockResolvedValue({});
      jest.spyOn(Member, 'find').mockResolvedValue([
        { userId: 'newadmin_id', username: 'newadmin', isStandupMember: false, isAdmin: true }
      ]);

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'add admin @newadmin',
        _id: 'msg_add_admin'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { userId: 'newadmin_id' },
        expect.objectContaining({ isAdmin: true }),
        { upsert: true }
      );
      expect(ADMIN_USER_IDS).toContain('newadmin_id');
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Added @newadmin to admins'),
        expect.any(String)
      );
    });

    it('should allow admin to remove an admin', async () => {
      api.get.mockResolvedValue({ user: { _id: 'oldadmin_id', username: 'oldadmin' } });
      const findOneAndUpdateSpy = jest.spyOn(Member, 'findOneAndUpdate').mockResolvedValue({});
      jest.spyOn(Member, 'find').mockResolvedValue([]);

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'remove admin @oldadmin',
        _id: 'msg_remove_admin'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { userId: 'oldadmin_id' },
        { isAdmin: false }
      );
      expect(ADMIN_USER_IDS).not.toContain('oldadmin_id');
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Removed @oldadmin from admins'),
        expect.any(String)
      );
    });
  });

  describe('Muting Logic', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    beforeEach(() => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
    });

    it('should allow admin to mute a date and notify summary channel', async () => {
      const findOneAndUpdateSpy = jest.spyOn(Mute, 'findOneAndUpdate').mockResolvedValue({});
      driver.getRoomId.mockResolvedValue('summary_room_id');
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'mute 2026-12-25 Christmas',
        _id: 'msg_mute'
      };

      await processStandupResponse(mockMessage);

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { date: expect.any(Date) },
        expect.objectContaining({ reason: 'Christmas', addedBy: 'admin1' }),
        { upsert: true }
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Standup muted for **2026-12-25** (Christmas)'),
        expect.any(String)
      );
      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          roomId: 'summary_room_id',
          text: expect.stringContaining('Standup Muted for 2026-12-25')
        })
      );
    });

    it('should allow admin to unmute a date and notify summary channel', async () => {
      const deleteOneSpy = jest.spyOn(Mute, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
      driver.getRoomId.mockResolvedValue('summary_room_id');
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'unmute 2026-12-25',
        _id: 'msg_unmute'
      };

      await processStandupResponse(mockMessage);

      expect(deleteOneSpy).toHaveBeenCalledWith({ date: expect.any(Date) });
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Standup unmuted for **2026-12-25**'),
        expect.any(String)
      );
      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          roomId: 'summary_room_id',
          text: expect.stringContaining('Standup Unmuted for 2026-12-25')
        })
      );
    });

    it('should allow admin to list mutes and format dates locally', async () => {
      jest.spyOn(Mute, 'find').mockReturnValue({
        sort: jest.fn().mockResolvedValue([
          { date: new Date(2026, 4, 1), reason: 'Holiday', addedBy: 'admin1' }
        ])
      });
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'list mutes',
        _id: 'msg_list_mutes'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Upcoming Muted Dates (1)'),
        expect.any(String)
      );
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('2026-05-01'),
        expect.any(String)
      );
    });

    it('should skip prompting if today is muted', async () => {
      jest.spyOn(Mute, 'findOne').mockResolvedValue({ reason: 'Public Holiday' });
      const { promptUsersForStandup } = require('../src/index');

      await promptUsersForStandup();

      expect(api.post).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({
          text: expect.stringContaining('Standup Muted Today'),
          text: expect.stringContaining('Public Holiday')
        })
      );
    });
  });

  describe('Report Feature', () => {
    const { driver, api } = require('@rocket.chat/sdk');
    const axios = require('axios');

    it('should generate a valid CSV string', () => {
      const mockRecords = [
        {
          date: new Date(2026, 4, 1),
          username: 'user1',
          status: 'answered',
          snoozeUntil: null,
          answers: [
            { question: 'Q1', answer: 'Answer "One"' },
            { question: 'Q2', answer: 'Answer, Two' }
          ]
        }
      ];

      const csv = generateCSV(mockRecords, 'user1');
      
      expect(csv).toContain('"Date","Username","Status","Snooze Until","Question 1: Q1","Question 2: Q2"');
      expect(csv).toContain('"2026-05-01","user1","answered","","Answer ""One""","Answer, Two"');
    });

    it('should allow admin to download report', async () => {
      ADMIN_USER_IDS.push('admin1');
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      api.get.mockResolvedValue({ user: { _id: 'user1_id', username: 'user1' } });
      
      // Mock standup records
      const mockRecords = [{ date: new Date(), username: 'user1', status: 'answered', answers: [] }];
      jest.spyOn(Standup, 'find').mockReturnValue({
        sort: jest.fn().mockResolvedValue(mockRecords)
      });

      // Mock SDK credentials
      api.currentLogin = { authToken: 'token', userId: 'botid' };

      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'download report @user1 2026-05-01 2026-05-31',
        _id: 'msg_download'
      };

      await processStandupResponse(mockMessage);

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/rooms.upload/'),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Auth-Token': 'token',
            'X-User-Id': 'botid'
          })
        })
      );
    });

    it('should reject download report if user not found', async () => {
      ADMIN_USER_IDS.push('admin1');
      api.get.mockResolvedValue(null); // User not found
      
      const mockMessage = {
        u: { _id: 'admin1', username: 'admin1' },
        msg: 'download report @nonexistent',
        _id: 'msg_download_fail'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Could not find user @nonexistent'),
        expect.any(String)
      );
    });
  });

  describe('Snooze Logic', () => {
    const { driver, api } = require('@rocket.chat/sdk');

    it('should allow snoozing an active session', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      const findByIdAndUpdateSpy = jest.spyOn(Standup, 'findByIdAndUpdate').mockResolvedValue({});
      
      // Setup active session
      standupResponses.set('user1', {
        username: 'user1',
        status: 'pending',
        dbId: 'dbid1',
        answers: []
      });

      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'snooze 10',
        _id: 'msg_snooze'
      };

      await processStandupResponse(mockMessage);

      expect(findByIdAndUpdateSpy).toHaveBeenCalledWith(
        'dbid1',
        expect.objectContaining({ snoozeUntil: expect.any(Date) })
      );
      expect(standupResponses.has('user1')).toBe(false);
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Standup snoozed'),
        expect.any(String)
      );
    });

    it('should re-prompt when snooze expires', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      const expiredRecords = [{
        _id: 'dbid1',
        userId: 'user1',
        username: 'user1',
        answers: [],
        status: 'pending'
      }];
      
      jest.spyOn(Standup, 'find').mockResolvedValue(expiredRecords);
      const findByIdAndUpdateSpy = jest.spyOn(Standup, 'findByIdAndUpdate').mockResolvedValue({});

      await checkSnoozes();

      expect(findByIdAndUpdateSpy).toHaveBeenCalledWith('dbid1', { snoozeUntil: null });
      expect(standupResponses.get('user1')).toMatchObject({ status: 'pending' });
      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('Snooze over'),
        expect.any(String)
      );
    });

    it('should show remaining snooze time', async () => {
      api.post.mockResolvedValue({ room: { _id: 'room1' } });
      
      const futureDate = new Date();
      futureDate.setMinutes(futureDate.getMinutes() + 15);
      
      jest.spyOn(Standup, 'findOne').mockResolvedValue({
        userId: 'user1',
        snoozeUntil: futureDate
      });

      const mockMessage = {
        u: { _id: 'user1', username: 'user1' },
        msg: 'show snooze',
        _id: 'msg_show_snooze'
      };

      await processStandupResponse(mockMessage);

      expect(driver.sendToRoomId).toHaveBeenCalledWith(
        expect.stringContaining('15 minutes'),
        expect.any(String)
      );
    });
  });
});
