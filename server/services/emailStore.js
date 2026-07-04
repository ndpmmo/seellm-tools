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
