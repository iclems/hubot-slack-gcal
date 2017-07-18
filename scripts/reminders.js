// Description:
//   Commands for interfacing with google calendar.
//
// Commands:
//   hubot enable calendar reminders
//   hubot disable calendar reminders

module.exports = function(robot) {
  var _ = require('underscore'),
      Util = require("util"),
      helpers = require('../lib/helpers'),
      googleapis = require('googleapis'),
      CALLBACK_URL= process.env.HUBOT_URL + "/google/calendar/webhook",
      uuid = require('node-uuid'),
      moment = require("moment");
  require('twix');
  var express = require('express');

  // create express app for handling google calendar webhook requests
  var app = express();

  app.configure(function() {
    app.use(app.router);
  });

  // store events for each user
  var events = {};
  var status_text = helpers.status_text;

  robot.brain.data.calendarUsers = robot.brain.data.calendarUsers ? robot.brain.data.calendarUsers : {};

  function get_calendar_user(userId) {
    var data = robot.brain.data.calendarUsers[userId];
    if (!data) {
      robot.brain.data.calendarUsers[userId] = {}
    }
    return robot.brain.data.calendarUsers[userId];
  }

  // set up watch renewal and get initial events list on startup
  function init_watch() {
    _.each(robot.brain.data.calendarUsers, function(user, userId) {
      if(user.calendar_notify_events) {
        setup_watch_renewal(user);
        user.last_event_update = null;
        getEvents(userId);
      }
    });
  }
  if (_.keys(robot.brain.users()).length > 0) {
    init_watch();
  } else {
    robot.brain.once("loaded", init_watch);
  }

  // checks each user's calendar events for any with a reminder due
  function checkReminders() {
    _.each(events, function(events, user_id) {
      console.log("checking events for " + user_id);
      var to_remind = _.filter(events, function(event) {
        var myStatus = _.find(event.attendees, function(a) { return a.self });
        if(myStatus && myStatus === "declined") return;
        var start_date = new Date(event.start.dateTime);
        var difference = start_date - new Date();
        return difference > 0 && difference <= 60*1000;
      });
      _.each(to_remind, function(event) {
        var attachment = helpers.event_slack_attachment(event, "Your meeting is about to start", { when: false });
        var user = robot.brain.userForId(user_id);
        robot.emit("google:calendar:actionable_event", user, event);
        helpers.dm(robot, user, undefined, attachment);
      });
    });
    _.delay(checkReminders, 60000-((new Date()) - moment().startOf('minute')));
  }
  _.delay(checkReminders, 60000-((new Date()) - moment().startOf('minute')));


  // Set up a calendar watch webhook for the given user
  function setup_calendar_watch(user, cb) {
    if(!cb) {
      var cb = function(err, res) {
        if(err) return console.log(err);
      }
    }
    robot.emit('google:authenticate', user, function(err, oauth) {
      getPrimaryCalendar(oauth, function(err, calendar) {
        if(err || !calendar) return cb(err, undefined);
        var id = uuid.v1();
        googleapis.calendar('v3').events.watch({ auth: oauth, resource: { type: 'web_hook', id: id, address: CALLBACK_URL }, calendarId: calendar.id}, function(err, resp) {
          if(err) return cb(err, undefined);
          get_calendar_user(user.id).calendar_watch_token = id;
          get_calendar_user(user.id).calendar_watch_expiration = resp.expiration;
          setup_watch_renewal(user);
          cb(undefined, undefined);
        });
      });
    });
  }

  // sets up a function to renew the users calendar watch when it expires
  function setup_watch_renewal(user) {
    var user_calendar_info = get_calendar_user(user.id);
    if (user_calendar_info && user_calendar_info.calendar_watch_expiration) {
      var diff = parseInt(user_calendar_info.calendar_watch_expiration) - new Date().getTime() - 2000;
      if(diff < 0) setup_calendar_watch(user);
      else _.delay(function() { setup_calendar_watch(user) }, diff);
      console.log(user.name + ' will renew calendar watch in ' + diff + 'ms');
    }
  }


  // populate events list for the given user
  function getEvents(userId) {
    var calendar_user = get_calendar_user(userId);
    var user = robot.brain.userForId(userId);
    if(!calendar_user.calendar_notify_events) return;
    robot.emit('google:authenticate', user, function(err, oauth) {
      getPrimaryCalendar(oauth, function(err, calendar) {
        if(err || !calendar) return console.log(err);
        var last_update = calendar_user.last_event_update;
        var params = { auth: oauth, orderBy: 'starttime', maxResults: 500, singleEvents: true, timeMin: new Date().toISOString(), calendarId: calendar.id };
        if(last_update) _.extend(params, { updatedMin: last_update });
        googleapis.calendar('v3').events.list(params, function(err, resp) {
          if(err) return console.log(err);
          var items = _.filter(resp.items, function(item) {
            return helpers.matchMeetingUrl(item.location) || helpers.matchMeetingUrl(item.description);
          });
          user.last_event_update = new Date().toISOString();
          if(!last_update || !events[userId]) {
            events[userId] = items;
          }
          else {
            // stores whether or not we have notified the user for an instance of a recurring event
            var recurrences = {};
            _.each(items, function(new_event) {
              var old_event = _.find(events[userId], function(o) { return o.id === new_event.id });
              // event has been updated
              if(old_event) {
                if(new_event.status === 'cancelled') {
                  var old_event = null;
                  events[userId] = _.reject(events[userId], function(o) {
                    if(o.id === new_event.id) {
                      old_event = o;
                      return true;
                    }
                    return false;
                  });
                  if(old_event) {
                    if(old_event.recurringEventId) {
                      if(recurrences[old_event.recurringEventId]) return;
                      recurrences[old_event.recurringEventId] = true;
                    }
                    var attachment = helpers.event_slack_attachment(old_event, "This event has been cancelled and removed from your calendar:", {description: false, hangout: false, organizer: false, location: false});
                    helpers.dm(robot, user, undefined, attachment);
                  }
                }
                else {
                  if(new_event.recurringEventId) {
                    if(recurrences[new_event.recurringEventId]) return _.extend(old_event, new_event);
                    recurrences[new_event.recurringEventId] = true;
                  }
                  var reply = "", changes = false;
                  _.each(new_event, function(v, new_key) {
                    if(!_.isEqual(new_event[new_key], old_event[new_key])) {
                      if(_.contains(['summary', 'description', 'location'], new_key)) {
                        changes = true;
                        reply += "\n*New " + new_key + ":* " + new_event[new_key];
                      }
                      // notify of attendee updates separately, only for your own events
                      if(new_key === "attendees" && new_event.creator.self) {
                        var new_attendees = [], updated_attendees = [];
                        _.each(v, function(attendee) {
                          if(attendee.resource) return;
                          var old_attendee = _.find(old_event.attendees, function(a) { return a.email === attendee.email; });
                          if(!old_attendee) return new_attendees.push(attendee);
                          if(attendee.responseStatus !== old_attendee.responseStatus) {
                            updated_attendees.push(attendee);
                          }
                        });
                        if(new_attendees.length > 0) {
                          helpers.dm(robot, user, _.map(new_attendees, function(a) { return a.displayName || a.email; }).join(", ") + " was invited to " + helpers.format_event_name(new_event));
                          robot.emit("google:calendar:actionable_event", user, new_event);
                        }
                        _.each(updated_attendees, function(a) {
                          helpers.dm(robot, user, (a.displayName || a.email) + " *" + status_text[a.responseStatus] + "* the event " + helpers.format_event_name(new_event));
                          robot.emit("google:calendar:actionable_event", user, new_event);
                        });
                      }
                    }
                  });
                  var old_start = old_event.start.dateTime || old_event.start.date,
                      old_end = old_event.end.dateTime || old_event.end.date,
                      new_start = new_event.start.dateTime || new_event.start.date,
                      new_end = new_event.end.dateTime || new_event.end.date;
                  if(old_start != new_start || old_end != new_end) {
                    changes = true;
                    reply += "\nIt's now at *" + helpers.format_event_date_range(new_event) + "*";
                  }
                  if(changes) {
                    reply = "The event " + helpers.format_event_name(old_event) + " has been updated:" + reply;
                    helpers.dm(robot, user, reply);
                    robot.emit("google:calendar:actionable_event", user, new_event);
                  }
                  _.extend(old_event, new_event);
                }
              }
              else if(new_event.status !== 'cancelled') {
                console.log("new event for " + userId + " " + new_event.summary);
                events[userId].push(new_event);
                if(new_event.recurringEventId) {
                  if(recurrences[new_event.recurringEventId]) return;
                  recurrences[new_event.recurringEventId] = true;
                }
                if(!new_event.creator.self) {
                  var attachment = helpers.event_slack_attachment(new_event, "You have been invited to the following event:", {myStatus: false});
                  robot.emit("google:calendar:actionable_event", user, new_event);
                  helpers.dm(robot, user, undefined, attachment);
                }
              }
            });
          }
        });
      });
    });
  }

  function disable_calendar_reminders(user) {
    user.calendar_notify_events = false;
    user.calendar_watch_token = null;
    user.calendar_watch_expiration = null;
  }


  app.post('/google/calendar/webhook', function(req, res) {
    var channel_id = req.get("X-Goog-Channel-ID"),
        resource_id = req.get("X-Goog-Resource-ID"),
        state = req.get("X-Goog-Resource-State"),
        expires = req.get("X-Goog-Channel-Expiration");
    console.log('Calendar Webhook');
    if (state === "exists") {
      var userId = null;
      _.find(robot.brain.data.calendarUsers, function(u, uid) {
        if (u.calendar_watch_token == channel_id) {
          userId = uid;
          return true;
        } else {
          return false;
        }
      });
      if (userId) {
        getEvents(userId);
      } else {
        googleapis
          .calendar('v3')
          .channels.stop({id: channel_id, resourceId: resource_id}, function(){});
      }
    }
    res.send(201);
  });


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

  function toggleCalendarReminders(msg, shouldEnable) {
    if (shouldEnable) {
      setup_calendar_watch(msg.message.user, function(err, res) {
        if(err) {
          msg.reply("Error enabling reminders");
          return console.log(err);
        }
        get_calendar_user(msg.message.user.id).calendar_notify_events = true;
        getEvents(msg.message.user.id);
        msg.reply("I'll remind you about upcoming events.");
      });
    } else {
      disable_calendar_reminders(msg.message.user);
      if(events[msg.message.user.id]) delete events[msg.message.user.id];
      msg.reply("OK, I won't remind you about upcoming events.");
    }
  }

  robot.respond(/enable calendar reminders/i, function(msg) {
    robot.emit('google:authenticate', msg, function(err, oauth) {
      toggleCalendarReminders(msg, true)
    });
  });

  robot.respond(/disable calendar reminders/i, function(msg) {
    toggleCalendarReminders(msg, false)
  });

  robot.respond(/refresh calendar events/i, function(msg) {
    getEvents(msg.message.user.id);
    msg.reply("I'll make sure I'm up-to-date.")
  });

  robot.router.use(app);

}
