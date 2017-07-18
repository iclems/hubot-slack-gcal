// Description:
//   Commands for interfacing with google calendar.
//
// Commands:
//   hubot create an event <event> - creates an event with the given quick add text
//   hubot reply <yes|no|maybe> - reply to the last event

module.exports = function(robot) {
  var _ = require('underscore'),
      helpers = require('../lib/helpers'),
      Util = require("util"),
      Fs = require("fs"),
      googleapis = require('googleapis');

  robot.brain.data.calendarUsers = robot.brain.data.calendarUsers ? robot.brain.data.calendarUsers : {};

  function get_calendar_user(userId) {
    var data = robot.brain.data.calendarUsers[userId];
    if (!data) {
      robot.brain.data.calendarUsers[userId] = {}
    }
    return robot.brain.data.calendarUsers[userId];
  }

  var groups = {};
  try {
    groups = JSON.parse(Fs.readFileSync("calendar-resources.json").toString());
  } catch(e) {
    console.warn("Could not find calendar-resources.json file");
  }

  function reply_with_new_event(msg, event, pretext) {
    var attachment = helpers.event_slack_attachment(event, pretext);
    robot.emit('slack.attachment', {channel: msg.message.room, attachments: [attachment]});
  }

  function getPrimaryCalendar(oauth, cb) {
    googleapis
      .calendar('v3')
      .calendarList.list({minAccessRole: 'owner', auth: oauth}, function(err, data) {
        if(err) return cb(err);
        cb(undefined, _.find(data.items, function(c) {
          return c.primary;
        }));
      });
  }

  robot.on("google:calendar:actionable_event", function(user, event) {
    get_calendar_user(user.id).last_event = event.id;
  });

  robot.respond(/create(me )?( an)? event (.*)/i, function(msg) {
    robot.emit('google:authenticate', msg, function(err, oauth) {
      getPrimaryCalendar(oauth, function(err, calendar) {
        if(err || !calendar) return msg.reply("Could not find your primary calendar");
        googleapis
        .calendar('v3')
        .events.quickAdd({ auth: oauth, calendarId: calendar.id, text: msg.match[3] }, function(err, event) {
          if(err || !event) return msg.reply("Error creating an event for " + calendar.summary);
          var id = event.id;
          get_calendar_user(msg.message.user.id).last_event = id;
          get_calendar_user(msg.message.user.id).last_event_calendar = id;
          reply_with_new_event(msg, event, "OK, I created an event for you:");
        });
      });
    });
  });

  var response_map = {
    "no": "declined",
    "maybe": "tentative",
    "yes": "accepted"
  };
  robot.respond(/(respond|reply) (yes|no|maybe)/i, function(msg) {
    robot.emit('google:authenticate', msg, function(err, oauth) {
      var event = get_calendar_user(msg.message.user.id).last_event;
      if (!event) {
        return msg.reply('I dont know what event you\'re talking about!');
      }
      getPrimaryCalendar(oauth, function(err, calendar_o) {
        if(err || !calendar_o) return msg.reply("Could not find your primary calendar");
        var calendar = calendar_o.id;
        googleapis.calendar('v3').events.get({ auth: oauth, alwaysIncludeEmail: true, calendarId: calendar, eventId: event }, function(err, event) {
          if(err) return msg.reply('Error getting event: ' + err);
          var attendees = event.attendees;
          var me = _.find(attendees, function(a) { return a.self });
          if(!me) return msg.reply("You are not invited to " + event.summary);
          me.responseStatus = response_map[msg.match[2]];
          googleapis.calendar('v3').events.patch({ auth: oauth, calendarId: calendar, eventId: event.id, resource: { attendees: attendees } }, function(err, event) {
            if(err) return msg.reply('Error saving status: ' + err);
            msg.reply("OK, you responded " + msg.match[2] + " to " + event.summary);
          });
        });
      });
    });
  });
}
