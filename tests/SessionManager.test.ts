/**
 * SessionManager Tests
 * 
 * Tests for session lifecycle management including creation,
 * expiration, subscriptions, and cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../src/test/mock/SessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(60000);
  });

  describe('Session Creation', () => {
    it('should create a new session with unique ID', () => {
      const session = manager.createSession();
      
      expect(session.sessionId).toBeTruthy();
      expect(session.initialized).toBe(false);
      expect(session.subscriptions).toBeInstanceOf(Set);
      expect(session.subscriptions.size).toBe(0);
      expect(session.lastActivity).toBeGreaterThan(0);
      expect(session.requestCount).toBe(0);
    });

    it('should create unique session IDs', () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();
      
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });
  });

  describe('Session Retrieval', () => {
    it('should retrieve existing session', () => {
      const session = manager.createSession();
      const retrieved = manager.getSession(session.sessionId);
      
      expect(retrieved).toBe(session);
    });

    it('should return null for non-existent session', () => {
      const retrieved = manager.getSession('non-existent-id');
      expect(retrieved).toBeNull();
    });

    it('should check if session exists', () => {
      const session = manager.createSession();
      
      expect(manager.hasSession(session.sessionId)).toBe(true);
      expect(manager.hasSession('non-existent')).toBe(false);
    });
  });

  describe('Session Activity', () => {
    it('should update activity timestamp', async () => {
      const session = manager.createSession();
      const initialActivity = session.lastActivity;
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      
      manager.updateActivity(session.sessionId);
      expect(session.lastActivity).toBeGreaterThan(initialActivity);
    });

    it('should increment request count', () => {
      const session = manager.createSession();
      expect(session.requestCount).toBe(0);
      
      manager.updateActivity(session.sessionId);
      expect(session.requestCount).toBe(1);
      
      manager.updateActivity(session.sessionId);
      expect(session.requestCount).toBe(2);
    });
  });

  describe('Session Initialization', () => {
    it('should mark session as initialized', () => {
      const session = manager.createSession();
      expect(session.initialized).toBe(false);
      
      manager.markInitialized(session.sessionId);
      expect(session.initialized).toBe(true);
    });

    it('should handle marking non-existent session', () => {
      // Should not throw
      expect(() => {
        manager.markInitialized('non-existent');
      }).not.toThrow();
    });
  });

  describe('Subscriptions', () => {
    it('should add subscription to session', () => {
      const session = manager.createSession();
      
      manager.addSubscription(session.sessionId, 'protokoll://transcripts');
      expect(session.subscriptions.has('protokoll://transcripts')).toBe(true);
    });

    it('should remove subscription from session', () => {
      const session = manager.createSession();
      
      manager.addSubscription(session.sessionId, 'protokoll://transcripts');
      manager.removeSubscription(session.sessionId, 'protokoll://transcripts');
      
      expect(session.subscriptions.has('protokoll://transcripts')).toBe(false);
    });

    it('should handle multiple subscriptions', () => {
      const session = manager.createSession();
      
      manager.addSubscription(session.sessionId, 'protokoll://transcripts');
      manager.addSubscription(session.sessionId, 'protokoll://entities/person');
      
      expect(session.subscriptions.size).toBe(2);
    });

    it('should handle subscription operations on non-existent session', () => {
      // Should not throw
      expect(() => {
        manager.addSubscription('non-existent', 'protokoll://test');
        manager.removeSubscription('non-existent', 'protokoll://test');
      }).not.toThrow();
    });
  });

  describe('Session Expiration', () => {
    it('should expire session immediately', () => {
      const session = manager.createSession();
      
      manager.expireSession(session.sessionId);
      
      expect(manager.getSession(session.sessionId)).toBeNull();
      expect(manager.hasSession(session.sessionId)).toBe(false);
    });

    it('should expire all sessions', () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();
      
      manager.expireAllSessions();
      
      expect(manager.getSession(session1.sessionId)).toBeNull();
      expect(manager.getSession(session2.sessionId)).toBeNull();
    });

    it('should expire session after N requests', () => {
      const session = manager.createSession();
      
      manager.expireSessionAfter(session.sessionId, 3);
      
      // First 2 requests should succeed
      manager.updateActivity(session.sessionId);
      expect(manager.hasSession(session.sessionId)).toBe(true);
      
      manager.updateActivity(session.sessionId);
      expect(manager.hasSession(session.sessionId)).toBe(true);
      
      // Third request should trigger expiration
      manager.updateActivity(session.sessionId);
      expect(manager.hasSession(session.sessionId)).toBe(false);
    });

    it('should expire session based on timeout', () => {
      const shortTimeout = 100; // 100ms
      const shortManager = new SessionManager(shortTimeout);
      
      const session = shortManager.createSession();
      
      // Wait for timeout
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const retrieved = shortManager.getSession(session.sessionId);
          expect(retrieved).toBeNull();
          resolve();
        }, shortTimeout + 50);
      });
    });
  });

  describe('Session Timeout', () => {
    it('should set custom session timeout', () => {
      manager.setSessionTimeout(30000);
      
      // Create session with new timeout
      const session = manager.createSession();
      expect(session).toBeTruthy();
    });
  });

  describe('Session Listing', () => {
    it('should get all active sessions', () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();
      
      const sessions = manager.getAllSessions();
      
      expect(sessions).toHaveLength(2);
      expect(sessions).toContain(session1);
      expect(sessions).toContain(session2);
    });

    it('should return empty array when no sessions', () => {
      const sessions = manager.getAllSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe('Session Cleanup', () => {
    it('should cleanup expired sessions', () => {
      const shortTimeout = 100;
      const shortManager = new SessionManager(shortTimeout);
      
      const session1 = shortManager.createSession();
      const session2 = shortManager.createSession();
      
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          shortManager.cleanupExpiredSessions();
          
          expect(shortManager.getSession(session1.sessionId)).toBeNull();
          expect(shortManager.getSession(session2.sessionId)).toBeNull();
          resolve();
        }, shortTimeout + 50);
      });
    });

    it('should not cleanup active sessions', () => {
      const session = manager.createSession();
      
      manager.cleanupExpiredSessions();
      
      expect(manager.hasSession(session.sessionId)).toBe(true);
    });
  });
});
