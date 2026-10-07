with params as
(
	SELECT
		'%Contact re-established with Hostile Ship contact:  [FIR]  XX Amur Leopard%' as MessageTextLike
)


SELECT
	DATEtime('2025-01-01', '+' || cast(gl.Time/60/60/24 as varchar) || ' DAY') as GameDate 
	,rss.Name as System
	,gl.MessageText
	,*
FROM
	FCT_GameLog as gl
inner JOIN
	vw_const as c
on
	c.RaceID = gl.RaceID
left join FCT_RaceSysSurvey as rss on rss.SystemID = gl.SystemID and rss.RaceID = c.RaceID
WHERE
	gl.MessageText like (select MessageTextLike from params)
order by
	gl.Time desc
