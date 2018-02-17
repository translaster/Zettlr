/**
 * BEGIN HEADER
 *
 * Contains:        ZettlrRenderer class
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         MIT
 *
 * Description:     Controls the whole renderer process.
 *
 * END HEADER
 */

// Enable communication with host process
const ZettlrRendererIPC = require('../zettlr-rendereripc.js');
const ZettlrDirectories = require('../zettlr-directories.js');
const ZettlrPreview     = require('../zettlr-preview.js');
const ZettlrEditor      = require('../zettlr-editor.js');
const ZettlrBody        = require('../zettlr-body.js');
const ZettlrOverlay     = require('../zettlr-overlay.js');
const ZettlrToolbar     = require('../zettlr-toolbar.js');
const ZettlrPomodoro    = require('../zettlr-pomodoro.js');

const Typo              = require('typo-js');
const remote            = require('electron').remote;

const {trans}           = require('../../common/lang/i18n.js');

/* CLASS */
class ZettlrRenderer
{
    constructor()
    {
        this.currentFile    = null;
        this.currentDir     = null;
        this.paths          = null;
        this.lang           = 'en_US'; // Default fallback

        // Spellchecking vars
        this.typoReady      = false;   // Flag indicating whether Typo has already loaded
        this.typoLang       = {};      // Which language(s) are we spellchecking?
        this.typoAff        = null;    // Contains the Aff-file data
        this.typoDic        = null;    // Contains the dic-file data
        this.typo           = [];      // Contains the Typo object to check with

        // Indicators whether or not one of these has been found
        this.pandoc         = false;
        this.pdflatex       = false;

        // Write translation data into renderer process's global var
        global.i18n         = remote.getGlobal('i18n');

        // Init the complete list of objects that we need
        this.ipc            = new ZettlrRendererIPC(this);
        this.directories    = new ZettlrDirectories(this);
        this.preview        = new ZettlrPreview(this);
        this.editor         = new ZettlrEditor(this);
        this.body           = new ZettlrBody(this);
        this.overlay        = new ZettlrOverlay(this);
        this.toolbar        = new ZettlrToolbar(this);
        this.pomodoro       = new ZettlrPomodoro(this);
    }

    init()
    {
        this.overlay.show(trans('init.welcome'));

        // First request the configuration
        // Now eventually switch the theme to dark
        this.ipc.send('config-get', 'darkTheme');
        this.ipc.send('config-get', 'snippets');
        this.ipc.send('config-get', 'app_lang');
        this.ipc.send('config-get-env', 'pandoc');
        this.ipc.send('config-get-env', 'pdflatex');

        // Request a first batch of files
        this.ipc.send('get-paths', {});

        // Also, request the typo things
        this.ipc.send('typo-request-lang', {});
    }

    handleEvent(event, arg)
    {
        switch(arg.command)
        {
            case 'paths':
            // arg contains a JSON with all paths and files
            // Initial command.
            this.body.closeQuicklook();
            this.setCurrentDir(arg.content);
            this.setCurrentFile(null);
            this.paths = arg.content;
            this.directories.empty();
            this.directories.refresh();
            this.preview.refresh();
            this.directories.select(arg.content.hash);
            break;

            case 'paths-update':
            // Update the paths
            this.updatePaths(arg.content);
            this.directories.refresh();
            this.preview.refresh();
            break;

            // DIRECTORIES
            case 'dir-set-current':
            // Received a new directory
            this.setCurrentDir(arg.content);
            this.directories.select(arg.content.hash);
            this.preview.refresh();
            break;

            case 'dir-find':
            // User wants to search in current directory.
            this.toolbar.focusSearch();
            break;

            case 'dir-open':
            // User has requested to open another folder. Notify host process.
            this.ipc.send('dir-open', {});
            break;

            case 'dir-rename':
            if(arg.content.hasOwnProperty('hash')) {
                // Another dir should be renamed
                // Rename a dir based on a hash -> find it
                this.body.requestNewDirName(this.findObject(arg.content.hash));
            } else if(this.getCurrentDir() != null) {
                // Root means the parent has no type property.
                if(this.getCurrentDir().parent.hasOwnProperty('type')) {
                    this.body.requestNewDirName(this.getCurrentDir());
                }
            }
            break;

            case 'dir-new':
            // User wants to create a new directory. Display modal
            if(arg.content.hasOwnProperty('hash')) {
                // User has probably right clicked
                this.body.requestDirName(this.findObject(arg.content.hash));
            } else {
                this.body.requestDirName(this.getCurrentDir());
            }
            break;

            case 'dir-delete':
            // The user has requested to delete the current file
            // Request from main process
            if(arg.content.hasOwnProperty('hash')) {
                this.ipc.send('dir-delete', { 'hash': arg.content.hash });
            } else {
                this.ipc.send('dir-delete', {});
            }
            break;

            // FILES

            case 'file-set-current':
            this.setCurrentFile(arg.content);
            this.preview.select(arg.content.hash);
            break;

            case 'file-open':
            // We have received a new file. So close the old and open the new
            this.editor.close();
            this.setCurrentFile(arg.content);
            this.preview.select(arg.content.hash);
            this.editor.open(arg.content);
            break;

            case 'file-close':
            // We have received a close-file command.
            this.editor.close();
            this.setCurrentFile(null);
            break;

            case 'file-save':
            // The user wants to save the currently opened file.
            let file = this.getCurrentFile();
            if(file == null) {
                // User wants to save an untitled file
                // Important: The main Zettlr-class expects hash to be null
                // for new files
                file = {};
            }
            file.content = this.editor.getValue();
            file.wordcount = this.editor.getWrittenWords(); // For statistical purposes only =D
            this.ipc.send('file-save', file);
            break;

            case 'file-rename':
            if(arg.content.hasOwnProperty('hash')) {
                // Another file should be renamed
                // Rename a file based on a hash -> find it
                this.body.requestNewFileName(this.findObject(arg.content.hash));
            }else if(this.getCurrentFile() != null) {
                this.body.requestNewFileName(this.getCurrentFile());
            }
            break;

            case 'file-new':
            // User wants to open a new file. Display modal
            if((arg.content != null) && arg.content.hasOwnProperty('hash')) {
                // User has probably right clicked
                this.body.requestFileName(this.findObject(arg.content.hash));
            } else {
                this.body.requestFileName(this.getCurrentDir());
            }
            break;

            case 'file-find':
            this.editor.openFind();
            break;

            case 'file-insert':
            this.preview.refresh();
            // this.preview.insert(arg.content);
            break;

            case 'file-delete':
            // The user has requested to delete the current file
            // Request from main process
            if(arg.content.hasOwnProperty('hash')) {
                this.ipc.send('file-delete', { 'hash': arg.content.hash });
            } else {
                this.ipc.send('file-delete', {});
            }
            break;

            case 'file-search-result':
            this.preview.handleSearchResult(arg.content);
            break;

            case 'toggle-theme':
            // User wants to switch the theme
            this.directories.toggleTheme();
            this.preview.toggleTheme();
            this.editor.toggleTheme();
            this.body.toggleTheme();
            this.toolbar.toggleTheme();
            if(arg.content !== 'no-emit') {
                this.ipc.send('toggle-theme'); // Notify host process for configuration save
            }
            break;

            case 'toggle-snippets':
            this.preview.toggleSnippets();
            if(arg.content !== 'no-emit') {
                this.ipc.send('toggle-snippets');
            }
            break;

            case 'toggle-directories':
            this.directories.toggleDisplay();
            this.preview.toggleDirectories();
            this.editor.toggleDirectories();
            break;

            case 'toggle-preview':
            this.editor.togglePreview();
            break;

            case 'export':
            if(this.getCurrentFile() != null) {
                this.body.displayExport(this.getCurrentFile());
            }
            break;

            case 'open-preferences':
            this.ipc.send('get-preferences', {});
            break;

            case 'preferences':
            this.body.displayPreferences(arg.content);
            break;

            // Execute a command with CodeMirror (Bold, Italic, Link, etc)
            case 'cm-command':
            this.editor.runCommand(arg.content);
            // After a codemirror command has been issued through this function
            // give the editor back focus
            this.editor.cm.focus();
            break;

            case 'config':
            switch(arg.content.key)
            {
                case 'darkTheme':
                // Will only be received once, so simply "toggle" from initial
                // light theme to dark
                if(arg.content.value == true) {
                    this.directories.toggleTheme();
                    this.preview.toggleTheme();
                    this.editor.toggleTheme();
                    this.body.toggleTheme();
                    this.toolbar.toggleTheme();
                }
                break;
                case 'snippets':
                // Will only be received once; if false toggle from initial "true"
                // state.
                if(!arg.content.value) {
                    this.preview.toggleSnippets();
                }
                break;
                case 'app_lang':
                this.lang = arg.content.value;
                break;
                case 'pandoc':
                this.pandoc = arg.content.value;
                break;
                case 'pdflatex':
                this.pdflatex = arg.content.value;
                break;
            }
            break;

            // SPELLCHECKING EVENTS
            case 'typo-lang':
            // arg.content contains an object holding trues and falses for all
            // languages to be checked simultaneously
            this.setSpellcheck(arg.content);
            // Also pass down the languages to the body so that it can display
            // them in the preferences dialog
            this.body.setSpellcheckLangs(arg.content);
            break;

            // Receive the typo aff!
            case 'typo-aff':
            this.typoAff = arg.content;
            this.requestLang('dic');
            break;

            // Receive the typo dic!
            case 'typo-dic':
            this.typoDic = arg.content;
            // Now we can finally initialize spell check:
            this.initTypo();
            break;

            case 'quicklook':
            this.ipc.send('file-get-quicklook', arg.content.hash);
            break;

            case 'file-quicklook':
            this.body.quicklook(arg.content);
            break;

            case 'notify':
            this.body.notify(arg.content);
            break;

            // Pomodoro timer toggle
            case 'pomodoro':
            this.pomodoro.popup();
            break;

            // Zoom
            case 'zoom-reset':
            this.editor.zoom(0); // <-- Sometimes I think I am stupid. Well, but it works, I guess.
            break;
            case 'zoom-in':
            this.editor.zoom(1);
            break;
            case 'zoom-out':
            this.editor.zoom(-1);
            break;

            default:
            console.log(trans('system.unknown_command', arg.command));
            break;
        }
    }

    // Helper function to find dummy file/dir objects based on a hash
    findObject(hash, obj = this.paths)
    {
        if(obj.hash == hash) {
            return obj;
        } else if(obj.hasOwnProperty('children')) {
            for(let c of obj.children) {
                let ret = this.findObject(hash, c);
                if(ret != null) {
                    return ret;
                }
            }
        }
        return null;
    }

    updatePaths(nData)
    {
        this.paths = nData;
        if(this.getCurrentDir()) {
            this.setCurrentDir(this.findObject(this.getCurrentDir().hash));
        } else {
            this.setCurrentDir(this.paths); // Reset
        }
        if(this.getCurrentFile()) {
            this.setCurrentFile(this.findObject(this.getCurrentFile().hash));
        }
    }

    // SPELLCHECKER FUNCTIONS
    setSpellcheck(langs)
    {
        this.overlay.update(trans('init.spellcheck.get_lang'));
        // langs is an object containing _all_ available languages and whether
        // they should be checked or not.
        for(let prop in langs) {
            if(langs[prop]) {
                // We should spellcheck - so insert into the object with a
                // false, indicating that it has not been loaded yet.
                this.typoLang[prop] = false;
            }
        }

        if(Object.keys(this.typoLang).length > 0) {
            this.requestLang('aff');
        } else {
            // We're already done!
            this.overlay.close();
        }
    }

    requestLang(type)
    {
        let req = null;
        for(let lang in this.typoLang) {
            if(!this.typoLang[lang]) {
                // We should load this lang
                req = lang;
                break;
            }
        }
        this.overlay.update(
            trans(
                'init.spellcheck.request_file',
                trans('dialog.preferences.app_lang.'+req)
            )
        );

        // Load the first lang (first aff, then dic)
        this.ipc.send('typo-request-' + type, req);
    }

    initTypo()
    {
        if(!this.typoLang) { return; }
        if(!this.typoAff)  { return; }
        if(!this.typoDic)  { return; }

        let lang = null;
        for(let l in this.typoLang) {
            if(!this.typoLang[l]) {
                // This language should be initialized
                lang = l;
                break;
            }
        }

        this.overlay.update(
            trans(
                'init.spellcheck.init',
                trans('dialog.preferences.app_lang.'+lang)
            )
        );

        // Initialize typo and we're set!
        this.typo.push(new Typo(lang, this.typoAff, this.typoDic));
        this.typoLang[lang] = true; // This language is now initialized

        this.overlay.update(
            trans(
                'init.spellcheck.init_done',
                trans('dialog.preferences.app_lang.'+lang)
            )
        );

        // Free memory
        this.typoAff = null;
        this.typoDic = null;

        let done = true;
        for(let l in this.typoLang) {
            if(!this.typoLang[l]) {
                done = false;
                break;
            }
        }

        if(!done) {
            // There is still at least one language to load. -> request next aff
            this.requestLang('aff');
        } else {
            // Done - enable language checking
            this.typoReady = true;
            this.overlay.close(); // Done!
        }
    }

    // This function takes a word and returns true or falls depending on
    // whether or not the word has been spelled correctly using the given
    // spellchecking language
    typoCheck(word)
    {
        if(!this.typoReady) {
            return true; // true means: No wrong spelling detected
        }

        for(let lang of this.typo) {
            if(lang.check(word)) {
                // As soon as the word is correct in any lang, break and return true
                return true;
            }
        }

        // No language reported the word exists
        return false;
    }

    typoSuggest(word)
    {
        if(!this.typoReady) {
            return [];
        }

        let ret = [];

        for(let lang of this.typo) {
            ret = ret.concat(lang.suggest(word));
        }

        return ret;
    }

    // END SPELLCHECKER

    // SEARCH FUNCTIONS
    // This class only acts as a pass-through
    beginSearch(term) { this.preview.beginSearch(term); }
    searchProgress(curIndex, count) { this.toolbar.searchProgress(curIndex, count); }
    endSearch() { this.toolbar.endSearch(); }

    updateWordCount(words) { this.toolbar.updateWordCount(words); }
    // Triggered by ZettlrDirectories - if user clicks on another dir

    requestDir(hash) { this.ipc.send('dir-select', hash); }
    requestMove(from, to) { this.ipc.send('request-move', { 'from': from, 'to': to }); }
    // Triggered by ZettlrPreview - if user clicks on another file
    requestFile(hash) { this.ipc.send('file-get', hash); }
    // Triggered by ZettlrBody - user has entered a new file name and confirmed
    requestNewFile(name, hash) { this.ipc.send('file-new', { 'name': name, 'hash': hash }); }
    // Also triggered by ZettlrBody, only for directory
    requestNewDir(name, hash) { this.ipc.send('dir-new', { 'name': name, 'hash': hash }); }
    // Also triggered by ZettlrBody on export
    requestExport(hash, ext) { this.ipc.send('export', { 'hash': hash, 'ext': ext}); }
    // Triggered by ZettlrBody on DirRename
    requestDirRename(val, hash) { this.ipc.send('dir-rename', { 'hash': hash, 'name': val }); }
    // Triggered by ZettlrBody on FileRename
    requestFileRename(val, hash) { this.ipc.send('file-rename', { 'hash': hash, 'name': val }); }
    saveSettings(cfg) { this.ipc.send('update-config', cfg); }
    setCurrentFile(newfile) { this.currentFile = newfile; }
    setCurrentDir(newdir) { this.currentDir = newdir; }
    getCurrentFile() { return this.currentFile; }
    getCurrentDir() { return this.currentDir; }
    getLocale() { return this.lang; }
    setModified() { this.ipc.send('file-modified', {}); }
} // END CLASS
