-- The client-activation notification linked to /clients/<id>, which has never
-- been a route — the trainer's client page lives at /pt-os/clients/<id>. Every
-- one of these opened the app's 404. New rows are fixed in
-- routes/client-activation.js; this repairs the ones already sitting in inboxes.
UPDATE notifications
   SET link = '/pt-os' || link
 WHERE type = 'client_activated'
   AND link LIKE '/clients/%';
