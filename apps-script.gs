/**
 * sf streets // 415 walk club — Google Sheets + Apps Script Backend (100% Free)
 *
 * SETUP (takes ~60 seconds on a personal @gmail.com account):
 * 1. Create a new Google Sheet at https://sheets.new (on your personal Gmail so "Anyone" access is allowed).
 * 2. Click Extensions -> Apps Script, paste this entire file into Code.gs, and click Save.
 * 3. Run `setupSheet()` once from the toolbar dropdown (authorizes the script & creates the tabs).
 * 4. Click Deploy -> New deployment -> Select type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web App URL (`https://script.google.com/macros/s/.../exec`) and paste it into
 *    `WALK_CLUB_SCRIPT_URL` in `app.js` (or into the Walk Club modal in the app).
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SF Walk Club')
    .addItem('1. Initialize Sheet Tabs', 'setupSheet')
    .addItem('2. Send Upcoming Walk Email Blast', 'sendUpcomingWalkEmailBlast')
    .addToUi();
}

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let subSheet = ss.getSheetByName('Subscribers');
  if (!subSheet) {
    subSheet = ss.insertSheet('Subscribers');
    subSheet.appendRow(['Timestamp', 'Name', 'Email', 'Neighborhood', 'Active']);
    subSheet.getRange('A1:E1').setFontWeight('bold');
  }

  let walkSheet = ss.getSheetByName('UpcomingWalk');
  if (!walkSheet) {
    walkSheet = ss.insertSheet('UpcomingWalk');
    walkSheet.appendRow(['Title', 'DateTime', 'MeetupSpot', 'Neighborhood', 'TargetStreets', 'Notes']);
    walkSheet.getRange('A1:F1').setFontWeight('bold');
    walkSheet.appendRow([
      'Walk #01: Haight & Buena Vista Loops',
      'Saturday · 10:30 AM',
      'Duboce Park Cafe',
      'Haight Ashbury',
      'Haight St, Waller St, Cole St, Belvedere St, Ashbury St',
      'Coffee at Duboce Park, then knocking out 18 blocks around Haight & Buena Vista.'
    ]);
  }
}

/**
 * GET endpoint: returns the latest UpcomingWalk row as JSON for the PWA.
 */
function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const walkSheet = ss.getSheetByName('UpcomingWalk');
  let upcoming = null;

  if (walkSheet && walkSheet.getLastRow() >= 2) {
    const row = walkSheet.getRange(walkSheet.getLastRow(), 1, 1, 6).getValues()[0];
    upcoming = {
      title: String(row[0] || ''),
      dateTime: String(row[1] || ''),
      meetupSpot: String(row[2] || ''),
      neighborhood: String(row[3] || ''),
      targetStreets: String(row[4] || '')
        .split(',')
        .map(function(s) { return s.trim(); })
        .filter(Boolean),
      notes: String(row[5] || '')
    };
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, upcomingWalk: upcoming }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST endpoint: subscribes a new email to the Subscribers tab.
 * Uses text/plain body so browsers send a simple CORS POST with no OPTIONS preflight.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || '').trim();
    const nhood = String(payload.neighborhood || '').trim();

    if (!email || email.indexOf('@') === -1) {
      return jsonResponse({ ok: false, error: 'Valid email required' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let subSheet = ss.getSheetByName('Subscribers');
    if (!subSheet) {
      setupSheet();
      subSheet = ss.getSheetByName('Subscribers');
    }

    // Deduplicate email
    const lastRow = subSheet.getLastRow();
    if (lastRow >= 2) {
      const existing = subSheet.getRange(2, 3, lastRow - 1, 1).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim().toLowerCase() === email) {
          return jsonResponse({ ok: true, status: 'already_subscribed' });
        }
      }
    }

    subSheet.appendRow([new Date().toISOString(), name, email, nhood, 'YES']);
    return jsonResponse({ ok: true, status: 'subscribed' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Sends the latest row in UpcomingWalk to all active subscribers in Subscribers.
 * Includes a deep-link to https://strange-habits.com/sf-streets/?streets=...
 */
function sendUpcomingWalkEmailBlast() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const walkSheet = ss.getSheetByName('UpcomingWalk');
  const subSheet = ss.getSheetByName('Subscribers');

  if (!walkSheet || walkSheet.getLastRow() < 2 || !subSheet || subSheet.getLastRow() < 2) {
    ui.alert('Make sure both UpcomingWalk and Subscribers have at least one row.');
    return;
  }

  const row = walkSheet.getRange(walkSheet.getLastRow(), 1, 1, 6).getValues()[0];
  const title = String(row[0] || 'SF Street Walk');
  const dateTime = String(row[1] || 'TBD');
  const meetupSpot = String(row[2] || 'TBD');
  const neighborhood = String(row[3] || 'San Francisco');
  const targetStreets = String(row[4] || '');
  const notes = String(row[5] || '');

  const mapUrl =
    'https://strange-habits.com/sf-streets/?streets=' +
    encodeURIComponent(targetStreets) +
    (neighborhood ? '&nhood=' + encodeURIComponent(neighborhood) : '');

  const subs = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 5).getValues();
  const activeEmails = [];
  for (var i = 0; i < subs.length; i++) {
    const email = String(subs[i][2] || '').trim();
    const active = String(subs[i][4] || 'YES').trim().toUpperCase();
    if (email && active !== 'NO') activeEmails.push({ name: String(subs[i][1] || ''), email: email });
  }

  const confirm = ui.alert(
    'Send Upcoming Walk Email?',
    'Send "' + title + '" to ' + activeEmails.length + ' subscriber(s)?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  for (var j = 0; j < activeEmails.length; j++) {
    const sub = activeEmails[j];
    const greeting = sub.name ? 'hey ' + sub.name.toLowerCase() + ',' : 'hey,';
    const body = [
      greeting,
      '',
      'new sf street walk on deck:',
      '',
      '• walk: ' + title,
      '• when: ' + dateTime,
      '• meetup: ' + meetupSpot + ' (' + neighborhood + ')',
      '• target streets: ' + targetStreets,
      notes ? '\n' + notes : '',
      '',
      'preview the highlighted route on the map:',
      mapUrl,
      '',
      '— tanner // strange-habits.com/sf-streets'
    ].join('\n');

    MailApp.sendEmail({
      to: sub.email,
      subject: '[sf streets] ' + title + ' (' + dateTime + ')',
      body: body
    });
  }

  ui.alert('Sent to ' + activeEmails.length + ' subscriber(s)!');
}
