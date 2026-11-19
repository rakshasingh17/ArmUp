/*
 * pdf-export.cjs -- "Download my report (PDF)"
 * --------------------------------------------
 * The page sends a finished, self-contained HTML summary. This module prints
 * it to PDF in a hidden window (no scripts, no network) and asks the user
 * where to save the file. Nothing is uploaded anywhere.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_HTML_BYTES = 2 * 1024 * 1024; // a report is a few KB; refuse anything absurd

// Turn whatever the page suggests into a safe file name ending in .pdf.
function safeFileName(name) {
  const base = String(name ?? '')
    .replace(/[^\w\- .]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim()
    .slice(0, 80);
  return `${base || 'ArmUp-report'}.pdf`.replace(/\.pdf\.pdf$/i, '.pdf');
}

function registerPdfExport({ ipcMain, dialog, BrowserWindow }) {
  ipcMain.handle('report:savePdf', async (event, html, suggestedName) => {
    if (typeof html !== 'string' || html.length === 0 || Buffer.byteLength(html) > MAX_HTML_BYTES) {
      return { ok: false, error: 'The report could not be prepared.' };
    }

    let printWin = null;
    try {
      // Hidden window that can only show this one page: scripts are off and it
      // is sandboxed, so the content cannot do anything but be printed.
      printWin = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          javascript: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await printWin.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { marginType: 'default' },
      });

      const parent = BrowserWindow.fromWebContents(event.sender) || undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        title: 'Save your ArmUp report',
        defaultPath: safeFileName(suggestedName),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { ok: true, canceled: true };

      const target = path.extname(filePath).toLowerCase() === '.pdf' ? filePath : `${filePath}.pdf`;
      await fs.promises.writeFile(target, pdf);
      return { ok: true, canceled: false, path: target };
    } catch (err) {
      console.error('[armup] PDF export failed:', err);
      return { ok: false, error: 'Could not create the PDF. Please try again.' };
    } finally {
      if (printWin && !printWin.isDestroyed()) printWin.destroy();
    }
  });
}

module.exports = { registerPdfExport, safeFileName };
