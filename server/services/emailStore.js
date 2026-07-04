import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The data directory is located at the root of the project
const BASE_DATA_DIR = path.resolve(__dirname, '../../data');

/**
 * Get the absolute directory path for a specific service and domain
 * @param {string} service - e.g. 'smtpdev'
 * @param {string} domain - e.g. 'seellm.web.id'
 * @returns {string}
 */
export function getDomainDir(service, domain) {
  const safeService = String(service).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const safeDomain = String(domain).toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  return path.join(BASE_DATA_DIR, 'bulkregistration', 'emailservice', safeService, safeDomain);
}

/**
 * Get the path to the emails.json file
 * @param {string} service
 * @param {string} domain
 * @returns {string}
 */
export function getEmailsFilePath(service, domain) {
  return path.join(getDomainDir(service, domain), 'emails.json');
}

/**
 * Read the list of generated emails for a service and domain
 * @param {string} service
 * @param {string} domain
 * @returns {Array<object>}
 */
export function readEmails(service, domain) {
  const filePath = getEmailsFilePath(service, domain);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[emailStore] Error reading emails file ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Write/overwrite the list of emails
 * @param {string} service
 * @param {string} domain
 * @param {Array<object>} emails
 * @returns {boolean}
 */
export function writeEmails(service, domain, emails) {
  const dirPath = getDomainDir(service, domain);
  const filePath = getEmailsFilePath(service, domain);
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(emails, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[emailStore] Error writing emails file ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Check if an email already exists in the store for this service and domain
 * @param {string} service
 * @param {string} domain
 * @param {string} email
 * @returns {boolean}
 */
export function emailExists(service, domain, email) {
  const list = readEmails(service, domain);
  const targetEmail = String(email).trim().toLowerCase();
  return list.some(item => String(item.email).trim().toLowerCase() === targetEmail);
}

/**
 * Add a new email to the store for a service and domain
 * @param {string} service
 * @param {string} domain
 * @param {object} emailData - e.g. { email: 'x@y.com', password: '...', createdAt: '...' }
 * @returns {boolean} - true if added successfully, false if duplicate or error
 */
export function addEmail(service, domain, emailData) {
  if (!emailData || !emailData.email) {
    return false;
  }
  const email = String(emailData.email).trim();
  if (emailExists(service, domain, email)) {
    return false; // Duplicate
  }
  const list = readEmails(service, domain);
  list.push({
    email,
    password: emailData.password || '',
    createdAt: emailData.createdAt || new Date().toISOString(),
    metadata: emailData.metadata || {}
  });
  return writeEmails(service, domain, list);
}

const FIRST_NAMES = ['john', 'jane', 'david', 'sarah', 'james', 'emily', 'michael', 'jessica', 'robert', 'mary', 'william', 'patricia', 'thomas', 'linda', 'richard', 'barbara', 'joseph', 'elizabeth', 'charles', 'susan'];
const LAST_NAMES = ['smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin'];

/**
 * Generate exactly `qty` of unique, non-existing email addresses for a service/domain.
 * @param {string} service
 * @param {string} domain
 * @param {object} options
 * @returns {Array<object>}
 */
export function generateUniqueEmails(service, domain, options = {}) {
  const {
    qty = 10,
    method = 'random',
    prefixText = 'user',
    suffixType = 'seq',
    startSeq = 1
  } = options;

  const existingList = readEmails(service, domain);
  const existingSet = new Set(existingList.map(item => String(item.email).trim().toLowerCase()));
  
  const results = [];
  const generatedSet = new Set();
  
  let currentSeq = parseInt(startSeq, 10) || 1;
  let attempts = 0;
  const maxAttempts = qty * 100; // Limit loop to prevent freeze

  while (results.length < qty && attempts < maxAttempts) {
    attempts++;
    let prefix = '';
    
    if (method === 'random') {
      prefix = Math.random().toString(36).substring(2, 10);
    } else if (method === 'prefix') {
      if (suffixType === 'seq') {
        prefix = `${prefixText}${currentSeq}`;
        currentSeq++;
      } else {
        const randVal = Math.floor(1000 + Math.random() * 9000);
        prefix = `${prefixText}${randVal}`;
      }
    } else if (method === 'name') {
      const fn = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
      const ln = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
      const randVal = Math.floor(10 + Math.random() * 990);
      prefix = `${fn}.${ln}${randVal}`;
    }

    const email = `${prefix}@${domain}`.toLowerCase();
    
    if (!existingSet.has(email) && !generatedSet.has(email)) {
      generatedSet.add(email);
      results.push({ email, exists: false });
    }
  }

  return results;
}
