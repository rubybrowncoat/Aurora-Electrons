SELECT 
	*
FROM
	FCT_JumpPoint as jp
left JOIN
	FCT_JumpPoint as jp2
on
	jp2.WarpPointID = jp.WPLink
WHERE
	jp.GameID = 34

	--3
	
--delete from FCT_JumpPoint where WarpPointID in (5773,5782)