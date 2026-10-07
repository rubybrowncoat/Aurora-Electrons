SELECT
	gl.IncrementID
	,gl.Time
	,gl.MessageText
	,gl.SystemID
	,substr(gl.MessageText,bodyNameStartIX,bodyNameEndIx-bodyNameStartIX) as bodyName
FROM
(
	SELECT
		gl.*
		,instr(gl.MessageText, 'discovered minerals on')+23 as bodyNameStartIx
		,instr(gl.MessageText, ':') as bodyNameEndIx	
	FROM
		FCT_GameLog as gl
	--inner JOIN
	--	FCT_SystemBody as s
	WHERE
		gl.RaceID = 607
	AND
		gl.MessageText like '%discovered minerals on%'
) as gl