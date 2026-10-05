SELECT
	jp.WarpPointID
	,jp.SystemID
	,s.SystemNumber
	,rss.Name
	,rss.RaceID
	,s2.SystemNumber
	,rss2.Name
	,rss2.RaceID
	,jpsurv.GameID
	--,abs(s.SystemNumber-s2.SystemNumber)
	--select *
FROM
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
) as Race 
inner JOIN
	FCT_RaceJumpPointSurvey as jpsurv
on 
	jpsurv.RaceID = Race.RaceID
AND	
	jpsurv.Explored = 1
inner JOIN
	FCT_JumpPoint as jp
on
	jp.WarpPointID = jpsurv.WarpPointID
inner JOIN
	FCT_System as s
on
	s.SystemID = jp.SystemID
inner JOIN
	FCT_RaceSysSurvey as rss
on
	rss.SystemID = s.SystemID
AND
	rss.RaceID = Race.RaceID
inner JOIN
	FCT_JumpPoint as jp2
on
	jp2.WarpPointID = jp.WPLink
inner JOIN
	FCT_System as s2
on
	s2.SystemID = jp2.SystemID

inner JOIN
	FCT_RaceSysSurvey as rss2
on
	rss2.SystemID = s2.SystemID
AND
	rss2.RaceID = Race.RaceID

order by
	s.SystemID
	--s.SystemNumber, s2.SystemNumber
	--3
	
--delete from FCT_JumpPoint where WarpPointID in (5773,5782)