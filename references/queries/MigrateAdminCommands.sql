update FCT_NavalAdminCommand
SET
	GameID = 999 -- put new GameID here
	,RaceID = 999 -- put new RaceID here
	, PopulationID = 999 -- put new PopulationID here
WHERE
	GameID = 999 -- put old GameID here
AND
	RaceID = 999 -- put old RaceID here
AND
	PopulationID = 999	-- put old PopulationID here
	
AND NavalAdminCommandID not in (1111,2222,3333) -- replace numbers with the appropriate IDs. add more if needed.