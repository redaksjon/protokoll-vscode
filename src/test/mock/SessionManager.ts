/**
 * Session Manager for Mock MCP Server
 * 
 * Handles session lifecycle including creation, tracking, expiration,
 * and controlled expiration for testing session recovery scenarios.
 */

import { randomBytes } from 'crypto';
import type { SessionData } from './types';

export class SessionManager {
  private sessions = new Map<string, SessionData>();
  private sessionTimeout: number;
  private expirationSchedules = new Map<string, { afterRequests: number }>();

  constructor(sessionTimeout = 60000) {
    this.sessionTimeout = sessionTimeout;
  }

  /**
   * Create a new session with a unique session ID
   */
  createSession(): SessionData {
    const sessionId = this.generateSessionId();
    const session: SessionData = {
      sessionId,
      initialized: false,
      subscriptions: new Set<string>(),
      lastActivity: Date.now(),
      requestCount: 0,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): SessionData | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // Check if session has expired
    if (Date.now() - session.lastActivity > this.sessionTimeout) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Update session activity timestamp and increment request count
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      session.requestCount++;

      // Check if session should be expired based on request count
      const schedule = this.expirationSchedules.get(sessionId);
      if (schedule && session.requestCount >= schedule.afterRequests) {
        this.expireSession(sessionId);
        this.expirationSchedules.delete(sessionId);
      }
    }
  }

  /**
   * Mark session as initialized (after successful initialize handshake)
   */
  markInitialized(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.initialized = true;
    }
  }

  /**
   * Add a subscription to a session
   */
  addSubscription(sessionId: string, uri: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscriptions.add(uri);
    }
  }

  /**
   * Remove a subscription from a session
   */
  removeSubscription(sessionId: string, uri: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscriptions.delete(uri);
    }
  }

  /**
   * Expire a session immediately
   */
  expireSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.expirationSchedules.delete(sessionId);
  }

  /**
   * Expire all sessions
   */
  expireAllSessions(): void {
    this.sessions.clear();
    this.expirationSchedules.clear();
  }

  /**
   * Schedule a session to expire after a certain number of requests
   * Useful for testing session recovery
   */
  expireSessionAfter(sessionId: string, requests: number): void {
    this.expirationSchedules.set(sessionId, { afterRequests: requests });
  }

  /**
   * Set the session timeout duration
   */
  setSessionTimeout(timeoutMs: number): void {
    this.sessionTimeout = timeoutMs;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): SessionData[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Check if a session exists and is valid
   */
  hasSession(sessionId: string): boolean {
    return this.getSession(sessionId) !== null;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Clean up expired sessions (can be called periodically)
   */
  cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeout) {
        this.sessions.delete(sessionId);
        this.expirationSchedules.delete(sessionId);
      }
    }
  }
}
