'use strict';

const axios = require('axios');

async function post(url, body, headers) {

    return axios.post(url, body, {
        headers,
        timeout: 30000
    });

}

module.exports = {
    post
};