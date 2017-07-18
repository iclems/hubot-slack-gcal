var _ = require('underscore'),
    Util = require("util"),
    helpers = require('../lib/helpers'),
    googleapis = require('googleapis'),
    CALLBACK_URL= process.env.HUBOT_URL + "/google/calendar/webhook",
    uuid = require('node-uuid'),
    moment = require("moment");
require('twix');

var helpers = {
  status_text: {
    "needsAction": "No response",
    "declined": "Declined",
    "tentative": "Maybe",
    "accepted": "Accepted"
  },

  event_slack_attachment: function(event, pretext, options) {
    var options = _.extend({
      description: false,
      when: true,
      myStatus: false,
      organizer: false,
      hangout: false,
      location: true,
      eventLink: false
    }, options || {});
    var attachment = {
      pretext: pretext,
      title: event.summary,
      title_link: event.htmlLink,
      fields: []
    };
    var reply = pretext || "";
    reply += " *" + event.summary + "*";
    var range = moment.parseZone(event.start.dateTime || event.start.date)
                .twix(moment.parseZone(event.end.dateTime || event.end.date));

    if (options.when) {
      reply += " on *" + helpers.format_event_date_range(event) + "*";
      attachment.fields.push({
        title: "When",
        value: helpers.format_event_date_range(event) + (event.recurringEventId ? " (recurring event)" : ""),
        "short": true
      });
    }

    if (options.description) {
      attachment.text = event.description;
      reply += "\n" + event.description;
    }

    if (options.hangout && event.hangoutLink) {
      attachment.fields.push({
        title: "Hangout",
        value: "<" + event.hangoutLink + "|Hangout Link>",
        "short": true
      })
      reply += "\Hangout Link: " + event.hangoutLink;
    }

    if (options.location && (event.location || helpers.matchMeetingUrl(event.description))) {
      var location = event.location;
      if (!helpers.matchMeetingUrl(location)) {
        location = [location, helpers.matchMeetingUrl(event.description)].join(', ');
      }
      attachment.fields.push({
        title: "Location",
        value: location,
        "short": true
      })
      reply += " @ " + location;
    }

    if (options.myStatus) {
      var myStatus = _.find(event.attendees, function(a) { return a.self });
      if(myStatus) {
        attachment.fields.push({
          title: "Your Status",
          value: helpers.status_text[myStatus.responseStatus],
          "short": true
        });
        reply += "\nYour status: " + helpers.status_text[myStatus.responseStatus];
      }
    }

    if (options.organizer) {
      attachment.fields.push({
        title: "Organizer",
        value: event.organizer.displayName,
        "short": true
      })
      reply += "\nOrganizer: " + event.organizer.displayName;
    }

    if (options.eventLink) {
      reply += "\n" + event.htmlLink;
    }

    attachment.fallback = reply;
    return attachment;
  },


  format_event_date_range: function(event) {
    var range = moment.parseZone(event.start.dateTime || event.start.date)
                .twix(moment.parseZone(event.end.dateTime || event.end.date));
    return range.format();
  },


  format_event_name: function(event) {
    return "*" + event.summary + "* (" + helpers.format_event_date_range(event) + ")";
  },

  dm: function(robot, user, reply, attachments) {
    robot.emit('slack.attachment', {channel: user.name, text: reply, attachments: attachments});
  },

  stripUnicodeChars:function(s) {
      return s.replace(/[^A-Za-z 0-9 \.,\?""!@#\$%\^&\*\(\)-_=\+;:<>\/\\\|\}\{\[\]`~]*/g, "");
  },

  matchMeetingUrl: function(text) {
    var meetingUrl = "";
    if ( text ) {
      text = decodeURI(encodeURI(text).replace(/%e2%80%8b/ig, "")); // Unicode nothing
      var links = text.match(/(http:\/\/|https:\/\/)?((main|intg|pprd|www|fuzebox)\.*)?(fuzemeeting\.com\/fuze|fuze\.me)(\/)([a-zA-Z0-9\/#?=&]*)/img);
      if (links && links.length) {
        meetingUrl = helpers.stripUnicodeChars(links[0]);
        if ( !meetingUrl.match(/https:\/\/|http:\/\//i) ) {
          meetingUrl = "https://" + meetingUrl;
        }
      }
    }

    return meetingUrl;
  }
}

module.exports = helpers;
