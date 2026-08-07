// ── Portal system-string catalog ───────────────────────────────────────────
// Every guest-facing string the TENANT does not author lives here: validation
// errors, OTP progress/error copy, connected-card states, doc-modal chrome, and
// the built-in defaults the splash config falls back to when a venue has not
// customised a field.
//
// Why a catalog rather than per-template markup: the 33 templates in
// portal/public/templates/ each bake the English copy into their HTML. Editing
// all 33 for every language is unmaintainable, so this file is injected into
// every template by injectBootGate() (portal/server.js) BEFORE config.js runs,
// and config.js/form-logic.js read every literal through HF_I18N.t().
//
// Fallback chain is deliberately three-deep: requested language → 'en' → the
// English literal the caller passes as the last argument. That last rung means a
// 404 on this file (AP walled-garden misconfig, CDN hiccup) degrades to exactly
// today's behaviour instead of blanking the page — the same failsafe reasoning
// as the boot gate's 4s timeout.
//
// The 'en' entries for the *_DEFAULTS keys must stay byte-identical to the copy
// baked into the templates' markup and to CONSENT_DEFAULTS in config.js, or a
// default-config venue flashes mismatched text when JS re-applies it.
//
// MIRROR NOTE: the supported set here must agree with SUPPORTED_LANGUAGES in
// cms/app/api/captive-portal/_lib/languages.js and
// captive-server/server/src/services/guestLanguage.ts.
(function () {
  var SUPPORTED = ['en', 'de', 'it', 'fr'];

  var CATALOG = {
    en: {
      // Built-in splash defaults (venue has not customised these)
      'splash.title': 'Connect to WiFi',
      'splash.subtitle': 'Enter your details to get online',
      'login.buttonText': 'Continue',
      'field.firstName.label': 'First Name',
      'field.lastName.label': 'Last Name',
      'field.email.label': 'Email Address',
      'field.phone.label': 'Phone Number',
      'field.firstName.placeholder': 'Jane',
      'field.lastName.placeholder': 'Smith',
      'field.email.placeholder': 'jane@example.com',
      'field.phone.placeholder': '7911 123456',
      'consent.heading': 'We care about your privacy',
      'consent.subheading': 'Stay in touch with us and find out more about the best offers',
      // LEGAL COPY — see the note above the `de` block before touching these.
      'consent.bodyParagraph.0': 'I consent to the collection and use of my personal data, provided via WiFi portal registration, by this venue for marketing purposes. I understand that I may withdraw my consent at any time, and that this will not affect the legality of any processing carried out prior to my withdrawal.',
      'consent.bodyParagraph.1': 'I also consent to receiving marketing communications from this venue via email or other electronic means. I understand that I can unsubscribe at any time using the method provided in each communication.',
      'consent.acceptButtonText': 'Accept',
      'consent.declineButtonText': "I don't want to stay in touch.",
      'verify.heading': 'Verify your details',
      'verify.subheading': "We'll send you a code to confirm it's you.",
      'verify.codeInputLabel': 'Verification code',
      'verify.sendButtonText': 'Send code',
      'verify.verifyButtonText': 'Verify',
      'verify.resendLabel': 'Resend code',
      'connected.title': "You're Connected!",
      'connected.subtitle': 'You now have internet access.',
      'connected.buttonText': 'Open heidifi.ai',

      // Form validation
      'error.firstName': 'Please enter your first name.',
      'error.lastName': 'Please enter your last name.',
      'error.email': 'Please enter a valid email address.',
      'error.phone': 'Please enter a valid phone number.',
      'error.fillIn': 'Please fill in: {0}',
      'error.generic': 'Something went wrong. Please try again.',

      // Verification step chrome
      'verify.channelPrompt': 'Send my code by',
      'verify.changeDestination': 'Use a different one',
      'verify.previewNote': 'Preview only — no code is sent.',
      'verify.codeSentTo': 'Enter the 6-digit code we sent to {0}',
      'verify.alreadySent': 'We already sent a code — check your messages.',
      'verify.alreadySentTo': 'We already sent a code to {0} — check your messages.',
      'verify.alsoTry': 'You can also try: {0}',
      'verify.attemptsLeft.one': '{0} attempt left.',
      'verify.attemptsLeft.other': '{0} attempts left.',
      'verify.sending': 'Sending code…',
      'verify.verifying': 'Verifying…',
      'verify.connecting': 'Connecting…',
      'verify.takingLonger': 'This is taking longer than usual.',
      'verify.tryAgain': 'Try again',
      'verify.resendCountdown': '{0} ({1}s)',

      'verifyError.invalid_code': 'That code is not right. Please check and try again.',
      'verifyError.code_expired': 'That code expired. Send a new one to continue.',
      'verifyError.too_many_attempts': 'Too many attempts. Please wait a few minutes and try again.',
      'verifyError.too_many_requests': 'Too many requests. Please wait a few minutes and try again.',
      'verifyError.invalid_destination': 'That contact detail does not look right. Go back and check it.',
      'verifyError.undeliverable': 'We could not reach you there.',
      'verifyError.channel_unavailable': 'That method is unavailable right now.',
      'verifyError.channel_not_enabled': 'That method is not available here.',
      'verifyError.provider_error': 'We could not send your code. Please try again.',
      'verifyError.ap_not_registered': 'This WiFi point is not set up. Please ask staff for help.',
      'verifyError.verification_unavailable': 'Verification is unavailable right now. Please ask staff for help.',

      // Connecting progress copy (timed; see VERIFY_CONNECT_COPY in form-logic.js)
      'connect.step1': 'Code confirmed — getting you online…',
      'connect.step2': 'Still connecting — this can take a few seconds.',
      'connect.step3': 'Almost there. Please keep this page open.',

      // Connected card
      'connected.continue': 'Continue',
      'connected.submit': 'Submit',
      'connected.saving': 'Saving…',
      'connected.saved': 'Saved',
      'connected.thanks': 'Thanks! Your response has been saved.',
      'connected.saveFailed': 'Could not save your response. Please try again.',
      'connected.redirecting': 'Redirecting…',
      'connected.redirectingIn': 'Redirecting… {0}s',
      'connected.redirectNote': 'Redirects to {0} after {1}s',

      // Document modal
      'doc.privacy': 'Privacy Policy',
      'doc.terms': 'Terms of Service',
      'doc.loading': 'Loading…',
      'doc.notAvailable': '{0} not available.',
      'doc.unavailable': 'Unable to load document. Please try again later.',
      'doc.close': 'Close',

      // Country selector
      'country.search': 'Search country…',
      'country.noResults': 'No results',

      // Language selector
      'lang.label': 'Language',

      // Post-submit (Android tail / iOS interstitial)
      'grant.activatingIn': 'Activating connection in {0}s…',
      'grant.connectNow': 'Connect Now',
      'grant.openBrowser': 'Open your browser and visit:',
      'grant.connecting': 'Connecting you to the internet…',
    },

    // ⚠ LEGAL-REVIEW GATE — the `consent.bodyParagraph.*` entries in the de/it/fr
    // blocks below are provisional translations of HeidiFi's own default consent
    // boilerplate. They are the fallback a venue gets when it has authored no
    // consent text of its own, and the text they render is persisted verbatim
    // into every guest's ConsentRecord. They must be reviewed by counsel before a
    // venue enables the corresponding language in production. A venue that
    // authors its own consent copy never reaches these.
    //
    // This is also why the CMS offers no "Translate from default" button for
    // consent paragraphs or legal documents: machine translation of text that
    // becomes a legal record is out of bounds. See SPLASH_RULES in
    // mcp/src/mcp/splashInterview.ts.
    de: {
      'splash.title': 'Mit WLAN verbinden',
      'splash.subtitle': 'Geben Sie Ihre Daten ein, um online zu gehen',
      'login.buttonText': 'Weiter',
      'field.firstName.label': 'Vorname',
      'field.lastName.label': 'Nachname',
      'field.email.label': 'E-Mail-Adresse',
      'field.phone.label': 'Telefonnummer',
      'field.firstName.placeholder': 'Anna',
      'field.lastName.placeholder': 'Müller',
      'field.email.placeholder': 'anna@beispiel.ch',
      'field.phone.placeholder': '79 123 45 67',
      'consent.heading': 'Ihre Privatsphäre ist uns wichtig',
      'consent.subheading': 'Bleiben Sie mit uns in Kontakt und erfahren Sie mehr über die besten Angebote',
      'consent.bodyParagraph.0': 'Ich willige ein, dass dieser Betrieb meine bei der WLAN-Portal-Registrierung angegebenen personenbezogenen Daten zu Marketingzwecken erhebt und verwendet. Mir ist bekannt, dass ich meine Einwilligung jederzeit widerrufen kann und dass die Rechtmässigkeit der bis zum Widerruf erfolgten Verarbeitung davon unberührt bleibt.',
      'consent.bodyParagraph.1': 'Ich willige ausserdem ein, Marketingmitteilungen dieses Betriebs per E-Mail oder auf anderem elektronischem Weg zu erhalten. Mir ist bekannt, dass ich mich jederzeit über den in jeder Mitteilung angegebenen Weg abmelden kann.',
      'consent.acceptButtonText': 'Akzeptieren',
      'consent.declineButtonText': 'Ich möchte nicht in Kontakt bleiben.',
      'verify.heading': 'Daten bestätigen',
      'verify.subheading': 'Wir senden Ihnen einen Code, um Ihre Identität zu bestätigen.',
      'verify.codeInputLabel': 'Bestätigungscode',
      'verify.sendButtonText': 'Code senden',
      'verify.verifyButtonText': 'Bestätigen',
      'verify.resendLabel': 'Code erneut senden',
      'connected.title': 'Sie sind verbunden!',
      'connected.subtitle': 'Sie haben jetzt Internetzugang.',
      'connected.buttonText': 'heidifi.ai öffnen',

      'error.firstName': 'Bitte geben Sie Ihren Vornamen ein.',
      'error.lastName': 'Bitte geben Sie Ihren Nachnamen ein.',
      'error.email': 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
      'error.phone': 'Bitte geben Sie eine gültige Telefonnummer ein.',
      'error.fillIn': 'Bitte ausfüllen: {0}',
      'error.generic': 'Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.',

      'verify.channelPrompt': 'Code senden per',
      'verify.changeDestination': 'Andere Angabe verwenden',
      'verify.previewNote': 'Nur Vorschau — es wird kein Code gesendet.',
      'verify.codeSentTo': 'Geben Sie den 6-stelligen Code ein, den wir an {0} gesendet haben',
      'verify.alreadySent': 'Wir haben bereits einen Code gesendet — bitte prüfen Sie Ihre Nachrichten.',
      'verify.alreadySentTo': 'Wir haben bereits einen Code an {0} gesendet — bitte prüfen Sie Ihre Nachrichten.',
      'verify.alsoTry': 'Sie können auch versuchen: {0}',
      'verify.attemptsLeft.one': 'Noch {0} Versuch.',
      'verify.attemptsLeft.other': 'Noch {0} Versuche.',
      'verify.sending': 'Code wird gesendet…',
      'verify.verifying': 'Wird geprüft…',
      'verify.connecting': 'Verbindung wird hergestellt…',
      'verify.takingLonger': 'Das dauert länger als gewöhnlich.',
      'verify.tryAgain': 'Erneut versuchen',
      'verify.resendCountdown': '{0} ({1}s)',

      'verifyError.invalid_code': 'Dieser Code stimmt nicht. Bitte prüfen Sie ihn und versuchen Sie es erneut.',
      'verifyError.code_expired': 'Dieser Code ist abgelaufen. Fordern Sie einen neuen an, um fortzufahren.',
      'verifyError.too_many_attempts': 'Zu viele Versuche. Bitte warten Sie einige Minuten und versuchen Sie es erneut.',
      'verifyError.too_many_requests': 'Zu viele Anfragen. Bitte warten Sie einige Minuten und versuchen Sie es erneut.',
      'verifyError.invalid_destination': 'Diese Kontaktangabe sieht nicht richtig aus. Gehen Sie zurück und prüfen Sie sie.',
      'verifyError.undeliverable': 'Wir konnten Sie dort nicht erreichen.',
      'verifyError.channel_unavailable': 'Diese Methode ist derzeit nicht verfügbar.',
      'verifyError.channel_not_enabled': 'Diese Methode ist hier nicht verfügbar.',
      'verifyError.provider_error': 'Wir konnten Ihren Code nicht senden. Bitte versuchen Sie es erneut.',
      'verifyError.ap_not_registered': 'Dieser WLAN-Zugangspunkt ist nicht eingerichtet. Bitte wenden Sie sich an das Personal.',
      'verifyError.verification_unavailable': 'Die Bestätigung ist derzeit nicht verfügbar. Bitte wenden Sie sich an das Personal.',

      'connect.step1': 'Code bestätigt — Sie werden online gebracht…',
      'connect.step2': 'Verbindung wird noch hergestellt — das kann einige Sekunden dauern.',
      'connect.step3': 'Fast geschafft. Bitte lassen Sie diese Seite geöffnet.',

      'connected.continue': 'Weiter',
      'connected.submit': 'Absenden',
      'connected.saving': 'Wird gespeichert…',
      'connected.saved': 'Gespeichert',
      'connected.thanks': 'Danke! Ihre Antwort wurde gespeichert.',
      'connected.saveFailed': 'Ihre Antwort konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      'connected.redirecting': 'Weiterleitung…',
      'connected.redirectingIn': 'Weiterleitung in {0}s',
      'connected.redirectNote': 'Leitet nach {1}s weiter zu {0}',

      'doc.privacy': 'Datenschutzerklärung',
      'doc.terms': 'Nutzungsbedingungen',
      'doc.loading': 'Wird geladen…',
      'doc.notAvailable': '{0} nicht verfügbar.',
      'doc.unavailable': 'Dokument konnte nicht geladen werden. Bitte später erneut versuchen.',
      'doc.close': 'Schliessen',

      'country.search': 'Land suchen…',
      'country.noResults': 'Keine Ergebnisse',

      'lang.label': 'Sprache',

      'grant.activatingIn': 'Verbindung wird in {0}s aktiviert…',
      'grant.connectNow': 'Jetzt verbinden',
      'grant.openBrowser': 'Öffnen Sie Ihren Browser und besuchen Sie:',
      'grant.connecting': 'Sie werden mit dem Internet verbunden…',
    },

    it: {
      'splash.title': 'Connettiti al WiFi',
      'splash.subtitle': 'Inserisci i tuoi dati per andare online',
      'login.buttonText': 'Continua',
      'field.firstName.label': 'Nome',
      'field.lastName.label': 'Cognome',
      'field.email.label': 'Indirizzo email',
      'field.phone.label': 'Numero di telefono',
      'field.firstName.placeholder': 'Giulia',
      'field.lastName.placeholder': 'Rossi',
      'field.email.placeholder': 'giulia@esempio.ch',
      'field.phone.placeholder': '79 123 45 67',
      'consent.heading': 'Teniamo alla tua privacy',
      'consent.subheading': 'Resta in contatto con noi e scopri le offerte migliori',
      'consent.bodyParagraph.0': 'Acconsento alla raccolta e all’utilizzo dei miei dati personali, forniti tramite la registrazione al portale WiFi, da parte di questa struttura per finalità di marketing. Sono consapevole di poter revocare il consenso in qualsiasi momento e che ciò non pregiudica la liceità del trattamento effettuato prima della revoca.',
      'consent.bodyParagraph.1': 'Acconsento inoltre a ricevere comunicazioni di marketing da questa struttura via email o con altri mezzi elettronici. Sono consapevole di potermi cancellare in qualsiasi momento utilizzando la modalità indicata in ogni comunicazione.',
      'consent.acceptButtonText': 'Accetta',
      'consent.declineButtonText': 'Non desidero restare in contatto.',
      'verify.heading': 'Verifica i tuoi dati',
      'verify.subheading': 'Ti invieremo un codice per confermare la tua identità.',
      'verify.codeInputLabel': 'Codice di verifica',
      'verify.sendButtonText': 'Invia codice',
      'verify.verifyButtonText': 'Verifica',
      'verify.resendLabel': 'Invia di nuovo il codice',
      'connected.title': 'Sei connesso!',
      'connected.subtitle': 'Ora hai accesso a internet.',
      'connected.buttonText': 'Apri heidifi.ai',

      'error.firstName': 'Inserisci il tuo nome.',
      'error.lastName': 'Inserisci il tuo cognome.',
      'error.email': 'Inserisci un indirizzo email valido.',
      'error.phone': 'Inserisci un numero di telefono valido.',
      'error.fillIn': 'Compila: {0}',
      'error.generic': 'Qualcosa è andato storto. Riprova.',

      'verify.channelPrompt': 'Inviami il codice via',
      'verify.changeDestination': 'Usa un altro recapito',
      'verify.previewNote': 'Solo anteprima — nessun codice viene inviato.',
      'verify.codeSentTo': 'Inserisci il codice di 6 cifre che abbiamo inviato a {0}',
      'verify.alreadySent': 'Abbiamo già inviato un codice — controlla i tuoi messaggi.',
      'verify.alreadySentTo': 'Abbiamo già inviato un codice a {0} — controlla i tuoi messaggi.',
      'verify.alsoTry': 'Puoi anche provare: {0}',
      'verify.attemptsLeft.one': '{0} tentativo rimasto.',
      'verify.attemptsLeft.other': '{0} tentativi rimasti.',
      'verify.sending': 'Invio del codice…',
      'verify.verifying': 'Verifica in corso…',
      'verify.connecting': 'Connessione in corso…',
      'verify.takingLonger': 'Sta richiedendo più tempo del solito.',
      'verify.tryAgain': 'Riprova',
      'verify.resendCountdown': '{0} ({1}s)',

      'verifyError.invalid_code': 'Il codice non è corretto. Controlla e riprova.',
      'verifyError.code_expired': 'Il codice è scaduto. Inviane uno nuovo per continuare.',
      'verifyError.too_many_attempts': 'Troppi tentativi. Attendi qualche minuto e riprova.',
      'verifyError.too_many_requests': 'Troppe richieste. Attendi qualche minuto e riprova.',
      'verifyError.invalid_destination': 'Questo recapito non sembra corretto. Torna indietro e controllalo.',
      'verifyError.undeliverable': 'Non siamo riusciti a contattarti a questo recapito.',
      'verifyError.channel_unavailable': 'Questo metodo non è disponibile al momento.',
      'verifyError.channel_not_enabled': 'Questo metodo non è disponibile qui.',
      'verifyError.provider_error': 'Non siamo riusciti a inviare il codice. Riprova.',
      'verifyError.ap_not_registered': 'Questo punto WiFi non è configurato. Chiedi aiuto al personale.',
      'verifyError.verification_unavailable': 'La verifica non è disponibile al momento. Chiedi aiuto al personale.',

      'connect.step1': 'Codice confermato — ti stiamo portando online…',
      'connect.step2': 'Connessione ancora in corso — può richiedere qualche secondo.',
      'connect.step3': 'Ci siamo quasi. Tieni aperta questa pagina.',

      'connected.continue': 'Continua',
      'connected.submit': 'Invia',
      'connected.saving': 'Salvataggio…',
      'connected.saved': 'Salvato',
      'connected.thanks': 'Grazie! La tua risposta è stata salvata.',
      'connected.saveFailed': 'Non è stato possibile salvare la risposta. Riprova.',
      'connected.redirecting': 'Reindirizzamento…',
      'connected.redirectingIn': 'Reindirizzamento tra {0}s',
      'connected.redirectNote': 'Reindirizza a {0} dopo {1}s',

      'doc.privacy': 'Informativa sulla privacy',
      'doc.terms': 'Termini di servizio',
      'doc.loading': 'Caricamento…',
      'doc.notAvailable': '{0} non disponibile.',
      'doc.unavailable': 'Impossibile caricare il documento. Riprova più tardi.',
      'doc.close': 'Chiudi',

      'country.search': 'Cerca paese…',
      'country.noResults': 'Nessun risultato',

      'lang.label': 'Lingua',

      'grant.activatingIn': 'Attivazione della connessione tra {0}s…',
      'grant.connectNow': 'Connetti ora',
      'grant.openBrowser': 'Apri il browser e visita:',
      'grant.connecting': 'Ti stiamo connettendo a internet…',
    },

    fr: {
      'splash.title': 'Se connecter au WiFi',
      'splash.subtitle': 'Saisissez vos coordonnées pour vous connecter',
      'login.buttonText': 'Continuer',
      'field.firstName.label': 'Prénom',
      'field.lastName.label': 'Nom',
      'field.email.label': 'Adresse e-mail',
      'field.phone.label': 'Numéro de téléphone',
      'field.firstName.placeholder': 'Marie',
      'field.lastName.placeholder': 'Dupont',
      'field.email.placeholder': 'marie@exemple.ch',
      'field.phone.placeholder': '79 123 45 67',
      'consent.heading': 'Nous respectons votre vie privée',
      'consent.subheading': 'Restez en contact avec nous et découvrez nos meilleures offres',
      'consent.bodyParagraph.0': 'Je consens à la collecte et à l’utilisation de mes données personnelles, fournies lors de l’inscription au portail WiFi, par cet établissement à des fins de marketing. Je comprends que je peux retirer mon consentement à tout moment et que cela n’affecte pas la licéité du traitement effectué avant mon retrait.',
      'consent.bodyParagraph.1': 'Je consens également à recevoir des communications marketing de cet établissement par e-mail ou par d’autres moyens électroniques. Je comprends que je peux me désinscrire à tout moment via la méthode indiquée dans chaque communication.',
      'consent.acceptButtonText': 'Accepter',
      'consent.declineButtonText': 'Je ne souhaite pas rester en contact.',
      'verify.heading': 'Vérifiez vos coordonnées',
      'verify.subheading': 'Nous vous enverrons un code pour confirmer votre identité.',
      'verify.codeInputLabel': 'Code de vérification',
      'verify.sendButtonText': 'Envoyer le code',
      'verify.verifyButtonText': 'Vérifier',
      'verify.resendLabel': 'Renvoyer le code',
      'connected.title': 'Vous êtes connecté !',
      'connected.subtitle': 'Vous avez maintenant accès à internet.',
      'connected.buttonText': 'Ouvrir heidifi.ai',

      'error.firstName': 'Veuillez saisir votre prénom.',
      'error.lastName': 'Veuillez saisir votre nom.',
      'error.email': 'Veuillez saisir une adresse e-mail valide.',
      'error.phone': 'Veuillez saisir un numéro de téléphone valide.',
      'error.fillIn': 'Veuillez remplir : {0}',
      'error.generic': 'Une erreur est survenue. Veuillez réessayer.',

      'verify.channelPrompt': 'Envoyer mon code par',
      'verify.changeDestination': 'Utiliser une autre coordonnée',
      'verify.previewNote': 'Aperçu uniquement — aucun code n’est envoyé.',
      'verify.codeSentTo': 'Saisissez le code à 6 chiffres que nous avons envoyé à {0}',
      'verify.alreadySent': 'Nous avons déjà envoyé un code — vérifiez vos messages.',
      'verify.alreadySentTo': 'Nous avons déjà envoyé un code à {0} — vérifiez vos messages.',
      'verify.alsoTry': 'Vous pouvez aussi essayer : {0}',
      'verify.attemptsLeft.one': 'Il reste {0} tentative.',
      'verify.attemptsLeft.other': 'Il reste {0} tentatives.',
      'verify.sending': 'Envoi du code…',
      'verify.verifying': 'Vérification…',
      'verify.connecting': 'Connexion…',
      'verify.takingLonger': 'Cela prend plus de temps que d’habitude.',
      'verify.tryAgain': 'Réessayer',
      'verify.resendCountdown': '{0} ({1}s)',

      'verifyError.invalid_code': 'Ce code est incorrect. Veuillez le vÃ©rifier et rÃ©essayer.',
      'verifyError.code_expired': 'Ce code a expirÃ©. Envoyez-en un nouveau pour continuer.',
      'verifyError.too_many_attempts': 'Trop de tentatives. Veuillez patienter quelques minutes et rÃ©essayer.',
      'verifyError.too_many_requests': 'Trop de demandes. Veuillez patienter quelques minutes et rÃ©essayer.',
      'verifyError.invalid_destination': 'Cette coordonnÃ©e ne semble pas correcte. Revenez en arriÃ¨re et vÃ©rifiez-la.',
      'verifyError.undeliverable': 'Nous n’avons pas pu vous joindre Ã  cette adresse.',
      'verifyError.channel_unavailable': 'Cette mÃ©thode est indisponible pour le moment.',
      'verifyError.channel_not_enabled': 'Cette mÃ©thode n’est pas disponible ici.',
      'verifyError.provider_error': 'Nous n’avons pas pu envoyer votre code. Veuillez rÃ©essayer.',
      'verifyError.ap_not_registered': 'Ce point WiFi n’est pas configurÃ©. Veuillez demander de l’aide au personnel.',
      'verifyError.verification_unavailable': 'La vÃ©rification est indisponible pour le moment. Veuillez demander de l’aide au personnel.',

      'connect.step1': 'Code confirmÃ© â connexion en coursâ¦',
      'connect.step2': 'Connexion toujours en cours â cela peut prendre quelques secondes.',
      'connect.step3': 'Presque terminÃ©. Veuillez garder cette page ouverte.',

      'connected.continue': 'Continuer',
      'connected.submit': 'Envoyer',
      'connected.saving': 'Enregistrement…',
      'connected.saved': 'Enregistré',
      'connected.thanks': 'Merci ! Votre réponse a été enregistrée.',
      'connected.saveFailed': 'Impossible d’enregistrer votre réponse. Veuillez réessayer.',
      'connected.redirecting': 'Redirection…',
      'connected.redirectingIn': 'Redirection dans {0}s',
      'connected.redirectNote': 'Redirige vers {0} après {1}s',

      'doc.privacy': 'Politique de confidentialité',
      'doc.terms': 'Conditions d’utilisation',
      'doc.loading': 'Chargement…',
      'doc.notAvailable': '{0} non disponible.',
      'doc.unavailable': 'Impossible de charger le document. Veuillez réessayer plus tard.',
      'doc.close': 'Fermer',

      'country.search': 'Rechercher un pays…',
      'country.noResults': 'Aucun résultat',

      'lang.label': 'Langue',

      'grant.activatingIn': 'Activation de la connexion dans {0}s…',
      'grant.connectNow': 'Se connecter maintenant',
      'grant.openBrowser': 'Ouvrez votre navigateur et visitez :',
      'grant.connecting': 'Connexion à internet en cours…',
    },
  };

  // Native names for the guest-facing selector — a guest looking for their
  // language scans for "Deutsch", not "German".
  var NATIVE_NAMES = { en: 'English', de: 'Deutsch', it: 'Italiano', fr: 'Français' };

  function interpolate(template, args) {
    if (!args.length) return template;
    return template.replace(/\{(\d+)\}/g, function (match, index) {
      var value = args[Number(index)];
      return value === undefined || value === null ? match : String(value);
    });
  }

  var current = 'en';

  var HF_I18N = {
    SUPPORTED: SUPPORTED,
    NATIVE_NAMES: NATIVE_NAMES,

    get lang() { return current; },

    setLang: function (code) {
      current = HF_I18N.normalize(code);
      return current;
    },

    normalize: function (code) {
      if (typeof code !== 'string') return 'en';
      // Accept regional tags ('de-CH' → 'de') so navigator.language works unchanged.
      var base = code.trim().toLowerCase().split(/[-_]/)[0];
      return SUPPORTED.indexOf(base) !== -1 ? base : 'en';
    },

    has: function (code) {
      return typeof code === 'string' && SUPPORTED.indexOf(code.trim().toLowerCase()) !== -1;
    },

    /**
     * t(key, ...args) — args fill {0}, {1}… placeholders.
     *
     * Pass the English literal as the FINAL argument at call sites that must
     * survive this file failing to load; when the key is unknown in both the
     * current language and 'en', the raw key is returned so a missing entry is
     * visible in QA rather than silently blank.
     */
    t: function (key) {
      var args = Array.prototype.slice.call(arguments, 1);
      var table = CATALOG[current] || CATALOG.en;
      var value = table[key];
      if (typeof value !== 'string') value = CATALOG.en[key];
      if (typeof value !== 'string') return key;
      return interpolate(value, args);
    },

    // Pluralisation kept as two explicit keys rather than string concatenation —
    // the plural rule differs per language and concatenation cannot express it.
    plural: function (baseKey, count) {
      var suffix = Math.abs(Number(count)) === 1 ? '.one' : '.other';
      return HF_I18N.t(baseKey + suffix, count);
    },

    nativeName: function (code) {
      return NATIVE_NAMES[HF_I18N.normalize(code)] || String(code || '').toUpperCase();
    },
  };

  window.HF_I18N = HF_I18N;
})();
