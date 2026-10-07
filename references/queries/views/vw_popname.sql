DROP VIEW IF EXISTS "main"."vw_popname";
CREATE VIEW vw_popname as 
SELECT
	pop.PopulationID
	,pop.PopName
	--,instr(pop.PopName,' ')
	,CASE
		WHEN instr(pop.PopName,' DSP') > 0 THEN pop.PopName 								-- for all DSP, take the full name
		WHEN instr(pop.PopName,' ') > 0 THEN substr(pop.PopName,1,instr(pop.PopName,' ')-1) -- for all others, take everything up to the first space character
		ELSE pop.PopName
	END as BasicPopName
FROM
	FCT_Population as pop
inner JOIN
	vw_const as c on c.RaceID = pop.RaceID