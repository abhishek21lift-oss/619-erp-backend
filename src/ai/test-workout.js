'use strict';

require('dotenv').config();

const workout = require('./services/workout.service');

(async () => {

    const member = {

        name: "Rahul",

        age: 28,

        gender: "Male",

        height: "175 cm",

        weight: "82 kg",

        goal: "Muscle Gain",

        experience: "Intermediate",

        trainingDays: 5,

        equipment: "Commercial Gym",

        injuries: "None",

        duration: "75 Minutes"

    };

    try {

        const plan = await workout.generate(member);

        console.log(JSON.stringify(plan, null, 2));

    } catch (err) {

        console.error(err);

    }

})();