/***********************************
 * Super Awesome Connector for WCS *
 ***********************************/

// require('dotenv').config();

// This section is for the deployment of the connector on heroku
// You can comment this out when running locally.
// *************************************************************
var http = require('http');
http.createServer(function(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/plain'
    });
    res.write('Super Awesome Connector for WCS');
    res.end();
}).listen(process.env.PORT || 6000);

// ping heroku every 10 minutes to keep the connector alive
setInterval(function() {
    http.get("http://pp-wcs-connector.herokuapp.com");
}, 600000);
// *************************************************************

var prompt = require('prompt-sync')();
var ConversationV1 = require('watson-developer-cloud/conversation/v1');
var MyCoolAgent = require('./MyCoolAgent');
var request = require('request');
var context = {};
var dialogID = "";
var answer = "";
var sc_answer = "";
var metadata = "";
var abc_metadata = "";
var typingdelay = parseInt(process.env.TYPING_DELAY, 10); // Convert the TYPING_DELAY env. variable to an integer
var snippetdelay = parseInt(process.env.SNIPPET_DELAY, 10); // Convert the ANSWER_DELAY env. variable to an integer
var closedelay = parseInt(process.env.CLOSE_DELAY, 10); // Convert the CLOSE_DELAY env. variable to an integer
var waittime = 0;
var item = 0;
var snippet = [];
var allSkills = [];
var skillName = "";
var skillId = 0;
var accountId = process.env.LP_ACCOUNT_ID;
var greenlight = 1;

// Watson Conversation credentials.
var conversation = new ConversationV1({
    username: process.env.WCS_USERNAME,
    password: process.env.WCS_PASSWORD,
    path: {
        workspace_id: process.env.WCS_WORKSPACE_ID
    },
    version_date: '2016-07-11'
});

// LE bot agent credentials.
var echoAgent = new MyCoolAgent({
    accountId: process.env.LP_ACCOUNT_ID,
    username: process.env.LP_ACCOUNT_USER,
    appKey: process.env.LP_ACCOUNT_APP_KEY,
    secret: process.env.LP_ACCOUNT_SECRET,
    accessToken: process.env.LP_ACCOUNT_ACCESS_TOKEN,
    accessTokenSecret: process.env.LP_ACCOUNT_ACCESS_TOKEN_SECRET
});

// API oauth1 credentials.
var oauth = {
    consumer_key: process.env.LP_API_APP_KEY,
    consumer_secret: process.env.LP_API_SECRET,
    token: process.env.LP_API_ACCESS_TOKEN,
    token_secret: process.env.LP_API_ACCESS_TOKEN_SECRET
};

// Process the conversation response.
function processResponse(err, response) {
    if (err) {
        console.error(err); // Oops - something went wrong.
        return;
    }

    context = response.context;

    if (response.output.text.length != 0) {

        // Initiate typing indicator prior to the bot response.
        echoAgent.publishEvent({
            "dialogId": dialogID,
            "event": {
                "type": "ChatStateEvent",
                "chatState": "COMPOSING"
            }
        }, (res, body) => {
            if (res) {
                console.error(res);
                console.error(body);
            }
        });

        // If an intent is detected, log it out to the console.
        if (response.intents.length > 0) {
            console.log('Detected intent: #' + response.intents[0].intent + ' - with a confidence of: ' + response.intents[0].confidence);
        }

        // If an entity is detected, log it out to the console.
        if (response.entities.length > 0) {
            console.log('Detected entity: @' + response.entities[0].entity + ' - with a confidence of: ' + response.entities[0].confidence);
        }

        setTimeout(function() { // Set the timeout function to simulate a delay from Watson so we can show the typing indicator.

            for (var i = 0; i < response.output.text.length; i++) {

                // Cancel typing indicator before the bot responds.
                echoAgent.publishEvent({
                    "dialogId": dialogID,
                    "event": {
                        "type": "ChatStateEvent",
                        "chatState": "ACTIVE"
                    }
                }, (res, body) => {
                    if (res) {
                        console.error(res);
                        console.error(body);
                    }
                });

                answer = response.output.text[i];

                console.log('Return message : ' + answer.substring(0, 50) + '...'); // Post the answer to the console, truncated for readability.

                // If structured content is detected, call the sendStructuredContent function.
                if (answer.startsWith("{")) {

                    if (typeof response.output.abc !== "undefined") {
                        metadata = response.output.abc.metadata;
                        // console.log('ABC metadata   : ' + metadata); // Post the answer to the console, truncated for readability.
                        sendABCStructuredContent(answer, metadata);
                    } else {
                        sendStructuredContent(answer);
                    }
                }

                // Else if line breaks in plain text messsage are detected, send as snippets.
                else if (answer.includes('|')) {

                    console.log('Message format : Plain text with snippets');
                    // Split the response into an array of snippets, and trim any whitespace either side of the snippets.
                    var answerarray = answer.split('|').map(item => item.trim());
                    // Send the first snippet directly so there is no delay after typing indicator.
                    item = 0;
                    snippet = answerarray[item];
                    sendMySnippet(snippet, item);
                    // Subsequent snippets are then sent via a callback function with the pre-defined snippet delay.
                    item = 1;
                    sendResponseSnippet(answerarray, item, 0, function(err, resp) {});

                }

                // Otherwise the response should just be sent a plain text.
                else {

                    sendPlainText(answer);

                }

                // Identify and then process any actions specified in the JSON response
                if (typeof response.output.action !== "undefined") {
                    if (typeof response.output.action.name !== "undefined") {

                        // If an action is detected, log the action out to the console.
                        console.log('Detected action: ' + response.output.action.name);

                        // If a close action is detected, close the conversation after a delay.
                        if (response.output.action.name === "close") {
                            setTimeout(function() { // Apply timeout function so customer can see the close message before the exit survey is displayed.
                                closeConversation();
                            }, closedelay) // delay in milliseconds before closing
                        }

                        // If an escalate action is detected, transfer to the specified human skill.
                        // If the transfer is requested during out-of-hours then set the right expectation with the customer.
                        if (response.output.action.name === "escalate") {

                            var currentDtTm = new Date();
                            var currentHour = currentDtTm.getHours();
                            var currentMins = currentDtTm.getMinutes();
                            var openHour = process.env.OPERATING_HOURS_START_HH;
                            var openMins = process.env.OPERATING_HOURS_START_MM;
                            var closeHour = process.env.OPERATING_HOURS_END_HH;
                            var closeMins = process.env.OPERATING_HOURS_END_MM;
                            var off_hours = true; // Assume off hours is true until it is evaluated as false
                            skillName = response.output.action.skill; // Set skillName to the value in the JSON response
                            skillId = convertSkill(); // Convert skillName to skillID

                            console.log('Opening hours  : ' + openHour + ':' + openMins + ' - ' + closeHour + ':' + closeMins);

                            if (currentHour > openHour && currentHour < closeHour) {
                                off_hours = false;
                            } else if (currentHour == openHour) {
                                if (currentMins >= openMins) {
                                    off_hours = false;
                                }
                            } else if (currentHour == closeHour) {
                                if (currentMins < closeMins) {
                                    off_hours = false;
                                }
                            }

                            if (off_hours) {
                                console.log('Current time   : ' + currentHour + ':' + currentMins + ' - Out of hours detected, sending notification snippets...');
                                var transferMessageOne = process.env.OPERATING_HOURS_MSG_1 + ' ' + openHour + ':' + openMins + ' - ' + closeHour + ':' + closeMins + '.';
                                var transferMessageTwo = process.env.OPERATING_HOURS_MSG_2;
                                var answerarray = [transferMessageOne, transferMessageTwo];

                                // Send operating hours info message snippets after regular transfer message.
                                sendResponseSnippet(answerarray, 0, function(err, resp) {});

                                // Then transfer the conversation to the specified skill after all messages have been sent.
                                waittime = snippetdelay * 3;
                                setTimeout(function() {
                                    transferConversation(skillId);
                                }, waittime);

                            } else {
                                console.log('Current time   : ' + currentHour + ':' + currentMins);
                                transferConversation(skillId);

                            }
                        }
                    }
                }
            }
        }, typingdelay) // delay in milliseconds for typing indication
    }
}

// This code sends the customer message to the bot.
echoAgent.on('MyCoolAgent.ContentEvent', (contentEvent) => {

    greenlight = 1;
    dialogID = contentEvent.dialogId;

    console.log("Sending message: " + contentEvent.message);
    message = contentEvent.message;

    setTimeout(function(){

        if(greenlight){
            conversation.message({
                input: {
                    text: message
                },
                context : context
            }, processResponse);
            greenlight = 0;
        }
    }, 100); //Pause for 100 milliseconds so only the last utterance from the customer is processed.

});

/*******************************************************************
 * Functions which are called by the main processResponse function *
 *******************************************************************/

// This function sends a Plain Text message to the UMS.
function sendPlainText(answer) {

    console.log('Message format : Plain text');
    echoAgent.publishEvent({
        dialogId: dialogID,
        event: {
            type: 'ContentEvent',
            contentType: 'text/plain',
            message: answer
        }
    }, (res, body) => {
        if (res) {
            console.error(res);
            console.error(body);
        }
    });

}

// This function sends a Structured Content message to the UMS.
function sendStructuredContent(answer) {

    console.log('Message format : LP Structured Content');
    sc_answer = JSON.parse(answer);

    echoAgent.publishEvent({
        dialogId: dialogID,
        event: {
            type: 'RichContentEvent',
            content: sc_answer
        }
    }, (res, body) => {
        if (res) {
            console.error(res);
            console.error(body);
        }
    });

}

// This function sends an ABC Structured Content message to the UMS.
function sendABCStructuredContent(answer, metadata) {

    console.log('Message format : ABC Structured Content');
    sc_answer = JSON.parse(answer);
    abc_metadata = JSON.parse(metadata);

    echoAgent.publishEvent({
        dialogId: dialogID,
        event: {
            type: 'RichContentEvent',
            content: sc_answer
        }
    }, null, abc_metadata, (res, body) => {
        if (res) {
            console.error(res);
            console.error(body);
        }
    });

}

// This function initiates the snippet callback function.
function sendResponseSnippet(answerarray, item) {

    callbackSnippet(answerarray, item, function(err, resp) {});

}

// This function recurses through the message snippet array and calls the sendMySnippet function.
function callbackSnippet(answerarray, item, callback) {

    snippet = answerarray[item];
    setTimeout(function() {
        sendMySnippet(snippet, item);
        item = item + 1;
        if (item < answerarray.length) {
            callbackSnippet(answerarray, item, callback);
        }
    }, snippetdelay);

}

// This function simply sends each snippet!
function sendMySnippet(snippet, item) {

    console.log('     Snippet ' + item + ' : -> ' + snippet.substring(0, 47) + '...');
    echoAgent.publishEvent({
        dialogId: dialogID,
        event: {
            type: 'ContentEvent',
            contentType: 'text/plain',
            message: snippet
        }
    }, (res, body) => {
        if (res) {
            console.error(res);
            console.error(body);
        }
    });

}

// This function closes an active conversation.
function closeConversation() {

    echoAgent.updateConversationField({
        conversationId: dialogID,
        conversationField: [{
            field: "ConversationStateField",
            conversationState: "CLOSE"
        }]
    }, function(err) {
        if (err) {
            console.log(err);
        } else {
            console.log("*** Conversation has been closed ***");
        }
    });

}

// This function transfers the active conversation to the specified skill.
function transferConversation(skillId) {

    echoAgent.updateConversationField({
        conversationId: dialogID,
        conversationField: [{
                field: "ParticipantsChange",
                type: "REMOVE",
                role: "ASSIGNED_AGENT"
            },
            {
                field: "Skill",
                type: "UPDATE",
                skill: skillId
            }
        ]
    }, function(err) {
        if (err) {
            console.log(err);
        } else {
            console.log("*** Transfer to SkillId '" + skillId + "' completed ***");
        }
    });

}

// This function retrieves all the Skill ID's and corresponding Skill Names and loads into an array.
function retrieveSkill() {

//    var baseURI = 'va-a.ac.liveperson.net' // Alpha
//    var baseURI = 'va.ac.liveperson.net' // US Production
    var baseURI = 'lo.ac.liveperson.net' // UK Production


    // Get a list of all the skills
    var url = 'https://' + baseURI + '/api/account/' + accountId + '/configuration/le-users/skills';
    request.get({
        url: url,
        oauth: oauth,
        json: true,
        headers: {
            'Content-Type': 'application/json'
        }
    }, function(e, r, b) {
        allSkills = b;
        console.log('*** Skills successfully loaded ***');

    });

}

// This function converts a Skill Name to a Skill ID.
function convertSkill() {

    var found = 0;
    for (var i = 0; i < allSkills.length; i++) {
        if (allSkills[i].name === skillName) {
            found = 1;
            console.log('Detected skill : ' + allSkills[i].name + ' <--> ' + allSkills[i].id);
            return allSkills[i].id;
        }
    }
    if (!found) {
        console.log('*** WARNING: skill not found ***');
        return -1;
    }

}

echoAgent.on('connected', data => {
    console.log('*** Retrieving skills from account ' + accountId + ' ***');
    retrieveSkill();
});

/*********************************** EOF ***********************************/
