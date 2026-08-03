'use strict';

require('dotenv').config();

const ai = require('./services/ai.gateway');

(async () => {

    try {

        const result = await ai.chat([
            {
                role: 'user',
                content: 'Reply with only the words: MY PT STUDIO AI ONLINE'
            }
        ]);

        console.log(result);

    } catch (err) {

        console.error(err);

    }

})();