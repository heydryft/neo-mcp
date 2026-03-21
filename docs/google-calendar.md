# Google Calendar

> *"Connect my Google Calendar"*

## Tools

<!-- AUTO-GENERATED:START -->
| Tool | Description | Parameters |
|------|-------------|------------|
| `gcal_connect` | Connect a Google Calendar account via OAuth. Opens Google sign-in in the browser. | — |
| `gcal_calendars` | List your Google Calendar calendars. | — |
| `gcal_events` | List upcoming calendar events. | `calendar_id?`, `time_min?`, `time_max?`, `max_results?`, `query?` |
| `gcal_event` | Get a specific calendar event. | `calendar_id?`, `event_id` |
| `gcal_create_event` | Create a calendar event. | `summary`, `description?`, `location?`, `start`, `end`, `attendees?`, `time_zone?`, `calendar_id?`, `recurrence?`, `add_meet?` |
| `gcal_update_event` | Update a calendar event. | `event_id`, `calendar_id?`, `summary?`, `description?`, `location?`, `start?`, `end?`, `time_zone?` |
| `gcal_delete_event` | Delete a calendar event. | `event_id`, `calendar_id?` |
| `gcal_respond` | Respond to a calendar invite (accept/decline/tentative). | `event_id`, `response`, `calendar_id?` |
| `gcal_quick_add` | Create an event from natural language text (e.g. 'Lunch with John tomorrow at noon'). | `text`, `calendar_id?` |
| `gcal_freebusy` | Check free/busy status for calendars. | `calendar_ids?`, `time_min`, `time_max` |
<!-- AUTO-GENERATED:END -->
