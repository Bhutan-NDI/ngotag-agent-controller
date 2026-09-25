import { CredoError } from "@credo-ts/core";
import { Mutex, withTimeout } from "async-mutex";

//#region src/context/TenantSessionMutex.ts
/**
* Keep track of the total number of tenant sessions currently active. This doesn't actually manage the tenant sessions itself, or have anything to do with
* the agent context. It merely counts the current number of sessions, and provides a mutex to lock new sessions from being created once the maximum number
* of sessions has been created. Session that can't be required withing the specified sessionsAcquireTimeout will throw an error.
*/
var TenantSessionMutex = class {
	constructor(logger, maxSessions, sessionAcquireTimeout) {
		this._currentSessions = 0;
		this.maxSessions = Number.POSITIVE_INFINITY;
		this.logger = logger;
		this.maxSessions = maxSessions;
		this.sessionMutex = withTimeout(new Mutex(), sessionAcquireTimeout, new CredoError(`Failed to acquire an agent context session within ${sessionAcquireTimeout}ms`));
	}
	/**
	* Getter to retrieve the total number of current sessions.
	*/
	get currentSessions() {
		return this._currentSessions;
	}
	set currentSessions(value) {
		this._currentSessions = value;
	}
	/**
	* Wait to acquire a session. Will use the session semaphore to keep total number of sessions limited.
	* For each session that is acquired using this method, the sessions MUST be closed by calling `releaseSession`.
	* Failing to do so can lead to deadlocks over time.
	*/
	async acquireSession() {
		this.logger.debug("Acquiring tenant session");
		if (this.sessionMutex.isLocked()) {
			this.logger.debug("Session mutex is locked, waiting for it to unlock");
			await this.sessionMutex.acquire();
			if (this.currentSessions < this.maxSessions) this.sessionMutex.release();
		}
		this.logger.debug(`Increasing current session count to ${this.currentSessions + 1} (max: ${this.maxSessions})`);
		this.currentSessions++;
		if (this.currentSessions >= this.maxSessions) {
			this.logger.debug(`Reached max number of sessions ${this.maxSessions}, locking mutex`);
			try {
				await this.sessionMutex.acquire();
			} catch (error) {
				// PATCH(session-release): the post-increment lock timed out. currentSessions was
				// already incremented above, so undo it before propagating or the slot leaks permanently.
				this.currentSessions--;
				throw error;
			}
		}
		this.logger.debug(`Acquired tenant session (${this.currentSessions} / ${this.maxSessions})`);
	}
	/**
	* Release a session from the session mutex. If the total number of current sessions drops below
	* the max number of sessions, the session mutex will be released so new sessions can be started.
	*/
	releaseSession() {
		this.logger.debug("Releasing tenant session");
		if (this.currentSessions > 0) {
			this.logger.debug(`Decreasing current sessions to ${this.currentSessions - 1} (max: ${this.maxSessions})`);
			this.currentSessions--;
		} else this.logger.warn("Total sessions is already at 0, and releasing a session should not happen in this case. Not decrementing current session count.");
		if (this.sessionMutex.isLocked() && this.currentSessions < this.maxSessions) {
			this.logger.debug(`Releasing session mutex as number of current sessions ${this.currentSessions} is below max number of sessions ${this.maxSessions}`);
			this.sessionMutex.release();
		}
	}
};

//#endregion
export { TenantSessionMutex };
//# sourceMappingURL=TenantSessionMutex.mjs.map