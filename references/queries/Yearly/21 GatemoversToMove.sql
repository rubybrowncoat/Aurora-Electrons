--gatemovers stationed at jps to systems with completed grav SurveySensors
SELECT
	f.FleetName
	,jp.JPName
	,rss.SurveyDone
	,*
FROM
	vw_const as c
inner join FCT_Fleet as f on f.RaceID = c.RaceID
inner JOIN
	vw_jumppoints as jp
on
	jp.Xcor = f.Xcor
AND
	jp.Ycor = f.Ycor
inner JOIN
	FCT_JumpPoint as jpDest
on
	jpDest.WarpPointID = jp.WarpPointID_Dest
inner JOIN
	FCT_RaceSysSurvey as rss
on
	rss.RaceID = c.RaceID
AND
	rss.SystemID = jpDest.SystemID
WHERE
	(f.FleetName like '.zip%' or f.FleetName like '.sw%')
AND
	rss.SurveyDone = 1