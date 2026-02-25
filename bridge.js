/**
 * Cursor Bridge - Utility for Cursor agents to interact with the Command Hub.
 *
 * Usage from Cursor agent context:
 *   1. Read jobs from  cursor-hub/jobs/queue/*.json
 *   2. Move to active: rename file to cursor-hub/jobs/active/
 *   3. Write results:  write to cursor-hub/jobs/completed/
 *   4. Request approval: write to cursor-hub/jobs/approvals/
 *   5. Check approval:  read the same file, check `resolved` field
 *
 * This file can also be run standalone to simulate job processing:
 *   node bridge.js --demo
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const JOBS_DIR = path.join(__dirname, 'jobs');
const DIRS = {
  queue: path.join(JOBS_DIR, 'queue'),
  active: path.join(JOBS_DIR, 'active'),
  completed: path.join(JOBS_DIR, 'completed'),
  approvals: path.join(JOBS_DIR, 'approvals'),
};

const bridge = {
  createApprovalRequest({ title, description, action, command, risk = 'medium', payload = {} }) {
    const id = uuidv4();
    const approval = {
      id,
      title,
      description,
      action,
      command,
      risk,
      payload,
      resolved: false,
      approved: null,
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(DIRS.approvals, `${id}.json`),
      JSON.stringify(approval, null, 2)
    );
    console.log(`[bridge] Approval request created: ${id}`);
    return id;
  },

  checkApproval(id) {
    const fp = path.join(DIRS.approvals, `${id}.json`);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  },

  async waitForApproval(id, timeoutMs = 300000, pollMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = this.checkApproval(id);
      if (data && data.resolved) return data;
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { id, resolved: true, approved: false, note: 'Timed out waiting for approval' };
  },

  pickupJob() {
    const files = fs.readdirSync(DIRS.queue).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    const file = files[0];
    const job = JSON.parse(fs.readFileSync(path.join(DIRS.queue, file), 'utf-8'));
    job.status = 'active';
    job.started_at = new Date().toISOString();
    fs.writeFileSync(path.join(DIRS.active, file), JSON.stringify(job, null, 2));
    fs.unlinkSync(path.join(DIRS.queue, file));
    console.log(`[bridge] Picked up job: ${job.title}`);
    return job;
  },

  completeJob(job, result = {}) {
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    job.result = result;
    const file = `${job.id}.json`;
    fs.writeFileSync(path.join(DIRS.completed, file), JSON.stringify(job, null, 2));
    const activePath = path.join(DIRS.active, file);
    if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
    console.log(`[bridge] Completed job: ${job.title}`);
  },

  updateJobProgress(job, progress) {
    job.progress = progress;
    const file = `${job.id}.json`;
    fs.writeFileSync(path.join(DIRS.active, file), JSON.stringify(job, null, 2));
  },
};

// Demo mode: simulate Cursor processing a job
if (process.argv.includes('--demo')) {
  (async () => {
    console.log('\n[demo] Creating a sample approval request...');
    const approvalId = bridge.createApprovalRequest({
      title: 'Install new dependency',
      description: 'The agent wants to install "axios" via npm',
      action: 'shell_command',
      command: 'npm install axios',
      risk: 'low',
    });
    console.log(`[demo] Waiting for approval on: ${approvalId}`);
    console.log('[demo] Go to the mobile dashboard and approve/deny it!\n');

    const result = await bridge.waitForApproval(approvalId, 60000);
    console.log(`[demo] Approval result:`, result.approved ? 'APPROVED' : 'DENIED');

    console.log('\n[demo] Simulating job pickup...');
    const job = bridge.pickupJob();
    if (job) {
      console.log(`[demo] Working on: ${job.title}`);
      bridge.updateJobProgress(job, '50% - analyzing code');
      await new Promise(r => setTimeout(r, 2000));
      bridge.completeJob(job, { summary: 'Task completed successfully', files_changed: 3 });
    } else {
      console.log('[demo] No jobs in queue. Submit one from the mobile dashboard first!');
    }
  })();
}

module.exports = bridge;
