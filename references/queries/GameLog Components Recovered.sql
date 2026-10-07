SELECT
	substr(gl.MessageText, 12, instr(gl.MessageText, ' completed by')-11) as ShipClass		-- note that instr is case sensitive
	,substr(gl.MessageText, instr(gl.MessageText, 'Components Recovered:')+23,instr(gl.MessageText, '.  Minerals')-instr(gl.MessageText, 'Components Recovered:')-23) as Components		-- note that instr is case sensitive
	--,instr(
	--,
	,gl.*
FROM
	vw_const as c
inner join FCT_GameLog as gl on gl.RaceID = c.RaceID
where gl.MessageText like '%components recovered:%'
order by 
	gl.IncrementID desc,
	gl.MessageText