# Report on Differences Between Twitter and Farcaster Implementations

## Overview
The `packages/client-twitter` and `packages/client-farcaster` implementations handle interactions differently, particularly in how they seek new interactions from their respective platforms. Below is a detailed comparison based on the `src/interactions.ts` files from both packages.

## Key Differences

1. **Polling Mechanism**:
   - **Twitter**: 
     - The `TwitterInteractionClient` class has a method `start()` that initiates a polling loop using `setTimeout`. It checks for new interactions every `TWITTER_POLL_INTERVAL` (default is 120 seconds).
     - The method `handleTwitterInteractions()` fetches mentions and tweets from target users, processes them, and generates responses.
   - **Farcaster**: 
     - The `FarcasterInteractionManager` class also has a `start()` method that sets up a polling loop. However, it fetches mentions using `getMentions()` and does not have a mechanism to fetch a timeline or new interactions in the same way as Twitter.
     - The `handleInteractions()` method processes mentions but does not actively seek new interactions from a timeline.

2. **Interaction Handling**:
   - **Twitter**:
     - The implementation actively checks for mentions and tweets from target users, processes them, and generates responses based on the content of those tweets.
     - It includes logic to filter out replies and retweets, ensuring only relevant tweets are processed.
   - **Farcaster**:
     - The implementation primarily focuses on mentions and does not have a similar mechanism to fetch new casts or interactions from a timeline.
     - It uses a spam filter to manage interactions and ensure that responses are not sent to blocked users.

3. **Response Generation**:
   - **Twitter**:
     - The response generation is based on the content of tweets and includes templates for generating responses.
     - It has a structured approach to determine if the agent should respond based on the context of the tweet and the agent's profile.
   - **Farcaster**:
     - The response generation is also based on mentions but lacks the same level of interaction with a timeline.
     - It uses a different set of templates and context management for generating responses.

## Recommendations for Implementing Twitter-like Interactions in Farcaster

1. **Implement Timeline Fetching**:
   - Introduce a method in the `FarcasterInteractionManager` to fetch new casts from the timeline, similar to how Twitter fetches tweets. This could involve creating a method that periodically checks for new casts and processes them.

   Get the FilterType.GlobalTrending feed and seek for topics agent is interest in using should respond with a new prompt like twitterMessageHandlerTemplate that use agent {topics} of interest

   this is the neynar docs for fetch global trending topics, limiting to 10, and seek once a day
   const feed = await client.fetchFeed({
    feedType: FeedType.Filter,
    filterType: FilterType.GlobalTrending,
    limit: 10,
  })

console.log(feed);

2. **Enhance Interaction Logic**:
   - Modify the `handleInteractions()` method to include logic for processing new casts from the timeline, similar to how Twitter processes tweets.
   
   import { ForYouProvider } from "@neynar/nodejs-sdk/neynar-api/v2";

const fid = 3;
const viewerFid = 10;
const provider = ForYouProvider.Mbd;
const limit = 20;
const providerMetadata = encodeURIComponent(
  JSON.stringify({
    filters: {
      channels: ["https://farcaster.group/founders"],
    },
  })
);

client
  .fetchFeedForYou(fid, {
    limit,
    viewerFid,
    provider,
    providerMetadata: providerMetadata,
  })
  .then((response) => {
    console.log("response:", response);
  });

3. **Align Response Generation**:
   - Ensure that the response generation logic in Farcaster aligns more closely with the Twitter implementation, allowing for a more dynamic interaction model that can respond to both mentions and timeline casts.

4. **Configuration Settings**:
   - Review and potentially align configuration settings such as polling intervals and user targeting to ensure consistency across both platforms.

## Implementation Plan

1. **Define Requirements**:
   - Identify specific requirements for fetching and processing timeline casts in Farcaster.

2. **Modify `FarcasterInteractionManager`**:
   - Implement a new method to fetch timeline casts.
   - Update the `handleInteractions()` method to include logic for processing these casts.

3. **Testing**:
   - Create unit tests to ensure that the new functionality works as expected and does not introduce regressions.

4. **Documentation**:
   - Update documentation to reflect the new interaction model and any configuration changes.

5. **Deployment**:
   - Deploy the changes to a staging environment for further testing before going live.